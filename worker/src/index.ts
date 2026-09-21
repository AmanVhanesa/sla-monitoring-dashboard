/**
 * SLA monitoring API - a stateless Cloudflare Worker.
 *
 * The Worker keeps nothing between requests. An upload is a row in D1, each
 * CSV slice is an independent request that cleans and upserts its own rows,
 * and the finalise call derives the window from what actually landed in the
 * database. Any invocation can therefore be served by any isolate, and a
 * retried slice is harmless.
 */

import { cleanChunk, addCounters, emptyCounters, type Counters } from './clean.ts';
import { computeStats, SLA_TARGET } from './stats.ts';

export interface Env {
  DB: D1Database;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function fail(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/* --------------------------------------------------------------- ingest --- */

const INSERT_CHECK = `
  INSERT INTO checks (
    upload_id, service_id, ts, day, service_name,
    status_code, outcome, latency_ms, latency_raw, latency_unit, agent, region
  ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
  ON CONFLICT (upload_id, service_id, ts) DO UPDATE SET
    service_name = excluded.service_name,
    status_code  = excluded.status_code,
    outcome      = excluded.outcome,
    latency_ms   = excluded.latency_ms,
    latency_raw  = excluded.latency_raw,
    latency_unit = excluded.latency_unit,
    agent        = excluded.agent,
    region       = excluded.region
  WHERE (CASE excluded.outcome WHEN 'down' THEN 2 WHEN 'up' THEN 1 ELSE 0 END)
      > (CASE checks.outcome   WHEN 'down' THEN 2 WHEN 'up' THEN 1 ELSE 0 END)
`;

/**
 * Two agents report most checks, so the same (service, instant) arrives twice.
 * The primary key collapses them into one logical check and the guard above
 * decides which report survives: a real failure beats a success, and both beat
 * an unusable reading. That last rule is what stops one agent's 999 from
 * erasing another agent's confirmed 200.
 *
 * It also makes ingestion idempotent - re-sending a slice cannot inflate the
 * availability denominator.
 */
const COUNTER_COLUMNS: Record<keyof Counters, string | null> = {
  received: 'rows_received',
  rejected: 'rows_rejected',
  tsIsoUtc: 'ts_iso_utc',
  tsOffset: 'ts_offset',
  tsEpoch: 'ts_epoch',
  tsAssumedUtc: 'ts_assumed_utc',
  latencyConverted: 'latency_converted',
  latencyMissing: 'latency_missing',
  latencyNegative: 'latency_negative',
  latencyUnparseable: 'latency_unparseable',
  statusInvalid: 'status_invalid',
  accepted: null,
  outcomeUp: null,
  outcomeDown: null,
};

function counterUpdateSql(): string {
  const assignments = Object.entries(COUNTER_COLUMNS)
    .filter(([, column]) => column !== null)
    .map(([, column], index) => `${column} = ${column} + ?${index + 2}`);
  return `UPDATE uploads SET ${assignments.join(', ')} WHERE id = ?1`;
}

function counterValues(counters: Counters): number[] {
  return Object.entries(COUNTER_COLUMNS)
    .filter(([, column]) => column !== null)
    .map(([key]) => counters[key as keyof Counters]);
}

async function handleChunk(env: Env, uploadId: string, request: Request): Promise<Response> {
  const upload = await env.DB.prepare('SELECT id, status FROM uploads WHERE id = ?1')
    .bind(uploadId)
    .first<{ id: string; status: string }>();
  if (!upload) return fail('unknown upload id', 404);

  const lineOffset = Number(new URL(request.url).searchParams.get('lineOffset') ?? 0);
  const csvText = await request.text();
  if (!csvText.trim()) return fail('empty chunk');

  let cleaned;
  try {
    cleaned = cleanChunk(csvText, lineOffset);
  } catch (error) {
    // A malformed header is fatal for the whole upload, not just this slice.
    await env.DB.prepare("UPDATE uploads SET status = 'failed' WHERE id = ?1")
      .bind(uploadId)
      .run();
    return fail(error instanceof Error ? error.message : 'could not parse chunk', 422);
  }

  const statements = cleaned.rows.map((row) =>
    env.DB.prepare(INSERT_CHECK).bind(
      uploadId,
      row.serviceId,
      row.ts,
      row.day,
      row.serviceName,
      row.statusCode,
      row.outcome,
      row.latencyMs,
      row.latencyRaw,
      row.latencyUnit,
      row.agent,
      row.region,
    ),
  );

  // Only a sample of rejected rows is persisted. The counters stay exact; the
  // examples are there so a user can see *what* was dropped without the store
  // growing without bound on a pathological file.
  for (const rejected of cleaned.rejected.slice(0, 25)) {
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO rejected_rows (upload_id, line, reason, raw) VALUES (?1, ?2, ?3, ?4)',
      ).bind(uploadId, rejected.line, rejected.reason, rejected.raw.slice(0, 500)),
    );
  }

  statements.push(
    env.DB.prepare(counterUpdateSql()).bind(uploadId, ...counterValues(cleaned.counters)),
  );

  await env.DB.batch(statements);

  return json({ uploadId, counters: cleaned.counters, rejected: cleaned.rejected.length });
}

/**
 * The check interval is measured from the data rather than assumed, because
 * downtime minutes are (failed checks x interval). If a future export moved to
 * 5 minute probes, a hard-coded 15 would triple every downtime figure and
 * every credit calculated from it.
 */
const INTERVAL_SQL = `
  WITH ordered AS (
    SELECT ts, LAG(ts) OVER (PARTITION BY service_id ORDER BY ts) AS previous_ts
    FROM checks WHERE upload_id = ?1
  )
  SELECT (strftime('%s', ts) - strftime('%s', previous_ts)) / 60 AS gap_minutes,
         COUNT(*) AS occurrences
  FROM ordered
  WHERE previous_ts IS NOT NULL
  GROUP BY gap_minutes
  ORDER BY occurrences DESC
  LIMIT 1
`;

async function handleComplete(env: Env, uploadId: string): Promise<Response> {
  const summary = await env.DB.prepare(
    `SELECT COUNT(*) AS stored, MIN(day) AS window_start, MAX(day) AS window_end,
            COUNT(DISTINCT service_id) AS services
     FROM checks WHERE upload_id = ?1`,
  )
    .bind(uploadId)
    .first<{ stored: number; window_start: string; window_end: string; services: number }>();

  if (!summary || summary.stored === 0) {
    await env.DB.prepare("UPDATE uploads SET status = 'failed' WHERE id = ?1").bind(uploadId).run();
    return fail('no usable rows were found in this file', 422);
  }

  const interval = await env.DB.prepare(INTERVAL_SQL)
    .bind(uploadId)
    .first<{ gap_minutes: number }>();
  const intervalMinutes = interval?.gap_minutes && interval.gap_minutes > 0 ? interval.gap_minutes : 15;

  await env.DB.prepare(
    `UPDATE uploads
     SET status = 'complete',
         rows_stored = ?2,
         rows_duplicate = MAX(0, rows_received - rows_rejected - ?2),
         window_start = ?3, window_end = ?4,
         service_count = ?5, interval_minutes = ?6
     WHERE id = ?1`,
  )
    .bind(
      uploadId,
      summary.stored,
      summary.window_start,
      summary.window_end,
      summary.services,
      intervalMinutes,
    )
    .run();

  return json({ upload: await getUpload(env, uploadId) });
}

/* ---------------------------------------------------------------- reads --- */

interface UploadRow {
  id: string;
  filename: string;
  uploaded_at: string;
  status: string;
  rows_received: number;
  rows_rejected: number;
  rows_stored: number;
  rows_duplicate: number;
  ts_iso_utc: number;
  ts_offset: number;
  ts_epoch: number;
  ts_assumed_utc: number;
  latency_converted: number;
  latency_missing: number;
  latency_negative: number;
  latency_unparseable: number;
  status_invalid: number;
  window_start: string | null;
  window_end: string | null;
  service_count: number;
  interval_minutes: number;
}

function shapeUpload(row: UploadRow) {
  return {
    id: row.id,
    filename: row.filename,
    uploadedAt: row.uploaded_at,
    status: row.status,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    serviceCount: row.service_count,
    intervalMinutes: row.interval_minutes,
    quality: {
      rowsReceived: row.rows_received,
      rowsRejected: row.rows_rejected,
      rowsStored: row.rows_stored,
      duplicatesCollapsed: row.rows_duplicate,
      timestampsIsoUtc: row.ts_iso_utc,
      timestampsOffsetConverted: row.ts_offset,
      timestampsEpochConverted: row.ts_epoch,
      timestampsAssumedUtc: row.ts_assumed_utc,
      latencyUnitConverted: row.latency_converted,
      latencyMissing: row.latency_missing,
      latencyNegative: row.latency_negative,
      latencyUnparseable: row.latency_unparseable,
      statusInvalid: row.status_invalid,
    },
  };
}

async function getUpload(env: Env, uploadId: string) {
  const row = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?1')
    .bind(uploadId)
    .first<UploadRow>();
  return row ? shapeUpload(row) : null;
}

/** Falls back to the upload's own window when the user has not filtered. */
function resolveRange(url: URL, upload: { windowStart: string | null; windowEnd: string | null }) {
  const from = url.searchParams.get('from') || upload.windowStart || '0000-01-01';
  const to = url.searchParams.get('to') || upload.windowEnd || '9999-12-31';
  return from <= to ? { from, to } : { from: to, to: from };
}

async function handleLogs(env: Env, uploadId: string, url: URL): Promise<Response> {
  const upload = await getUpload(env, uploadId);
  if (!upload) return fail('unknown upload id', 404);

  const { from, to } = resolveRange(url, upload);
  const service = url.searchParams.get('service');
  const outcome = url.searchParams.get('outcome');
  const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? 100) || 100, 500);
  const page = Math.max(Number(url.searchParams.get('page') ?? 1) || 1, 1);

  const filters = ['upload_id = ?1', 'day >= ?2', 'day <= ?3'];
  const bindings: unknown[] = [uploadId, from, to];
  if (service) {
    bindings.push(service);
    filters.push(`service_id = ?${bindings.length}`);
  }
  if (outcome) {
    bindings.push(outcome);
    filters.push(`outcome = ?${bindings.length}`);
  }
  const where = filters.join(' AND ');

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM checks WHERE ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();
  const total = totalRow?.total ?? 0;

  const rows = await env.DB.prepare(
    `SELECT service_id, service_name, ts, status_code, outcome, latency_ms,
            latency_raw, latency_unit, agent, region
     FROM checks WHERE ${where}
     ORDER BY ts DESC, service_id ASC
     LIMIT ?${bindings.length + 1} OFFSET ?${bindings.length + 2}`,
  )
    .bind(...bindings, pageSize, (page - 1) * pageSize)
    .all();

  return json({
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    range: { from, to },
    rows: (rows.results ?? []).map((row: any) => ({
      serviceId: row.service_id,
      serviceName: row.service_name,
      ts: row.ts,
      statusCode: row.status_code,
      outcome: row.outcome,
      latencyMs: row.latency_ms,
      latencyRaw: row.latency_raw,
      latencyUnit: row.latency_unit,
      agent: row.agent,
      region: row.region,
    })),
  });
}

/* --------------------------------------------------------------- router --- */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const segments = path.split('/').filter(Boolean); // ["api", "uploads", ":id", ...]

    try {
      if (path === '/' || path === '/api/health') {
        return json({ status: 'ok', service: 'sla-monitoring-api', slaTarget: SLA_TARGET });
      }

      if (segments[0] !== 'api' || segments[1] !== 'uploads') return fail('not found', 404);

      const uploadId = segments[2];
      const action = segments[3];

      if (!uploadId) {
        if (request.method === 'POST') {
          const body = (await request.json().catch(() => ({}))) as { filename?: string };
          const id = crypto.randomUUID();
          await env.DB.prepare(
            'INSERT INTO uploads (id, filename, uploaded_at, status) VALUES (?1, ?2, ?3, ?4)',
          )
            .bind(id, body.filename?.slice(0, 200) || 'upload.csv', new Date().toISOString(), 'receiving')
            .run();
          return json({ uploadId: id }, 201);
        }

        const rows = await env.DB.prepare(
          'SELECT * FROM uploads ORDER BY uploaded_at DESC LIMIT 25',
        ).all<UploadRow>();
        return json({ uploads: (rows.results ?? []).map(shapeUpload) });
      }

      if (action === 'chunk' && request.method === 'POST') return handleChunk(env, uploadId, request);
      if (action === 'complete' && request.method === 'POST') return handleComplete(env, uploadId);

      const upload = await getUpload(env, uploadId);
      if (!upload) return fail('unknown upload id', 404);

      if (!action) return json({ upload });

      if (action === 'stats') {
        const { from, to } = resolveRange(url, upload);
        const stats = await computeStats(env.DB, uploadId, from, to, upload.intervalMinutes);
        return json({ upload, range: { from, to }, slaTarget: SLA_TARGET, ...stats });
      }

      if (action === 'logs') return handleLogs(env, uploadId, url);

      if (action === 'rejected') {
        const rows = await env.DB.prepare(
          'SELECT line, reason, raw FROM rejected_rows WHERE upload_id = ?1 ORDER BY line LIMIT 25',
        )
          .bind(uploadId)
          .all();
        return json({ rejected: rows.results ?? [] });
      }

      return fail('not found', 404);
    } catch (error) {
      console.error(error);
      return fail(error instanceof Error ? error.message : 'unexpected error', 500);
    }
  },
};

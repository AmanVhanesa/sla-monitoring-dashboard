/**
 * SLA maths and the queries behind the dashboard's stats section.
 *
 * Aggregation runs in SQL so the Worker never pulls a whole dataset into
 * memory; the one exception is incident grouping, which needs consecutive
 * rows and only ever touches the failed checks (a few hundred at most).
 */

/** The availability floor below which a billing credit is owed. */
export const SLA_TARGET = 0.999;

export interface ServiceStats {
  serviceId: string;
  serviceName: string;
  upChecks: number;
  downChecks: number;
  unknownChecks: number;
  evaluatedChecks: number;
  availability: number | null;
  meetsSla: boolean | null;
  downtimeMinutes: number;
  errorBudgetMinutes: number;
  errorBudgetUsedPct: number | null;
  latency: LatencyStats | null;
}

export interface LatencyStats {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  avg: number | null;
  max: number | null;
  samples: number;
  missing: number;
}

export interface Incident {
  serviceId: string;
  serviceName: string;
  start: string;
  end: string;
  durationMinutes: number;
  failedChecks: number;
}

export interface DailyPoint {
  serviceId: string;
  day: string;
  upChecks: number;
  downChecks: number;
  availability: number | null;
}

/**
 * Availability deliberately excludes "unknown" readings from both sides of the
 * ratio. An out-of-range status code means the agent's probe did not complete,
 * so it is evidence about the monitoring, not about the service. Counting it
 * as downtime would pay out credits for a monitoring bug; counting it as
 * uptime would hide real failures. Excluding it keeps the ratio honest and the
 * count is shown separately on the dashboard.
 */
export function availabilityOf(upChecks: number, downChecks: number): number | null {
  const evaluated = upChecks + downChecks;
  if (evaluated === 0) return null;
  return upChecks / evaluated;
}

/**
 * Group consecutive failed checks into incidents.
 *
 * A single isolated 5xx is background noise - a retry would very likely have
 * succeeded - so an incident requires at least `minConsecutive` failures in a
 * row. A gap larger than one check interval (with tolerance for jitter) ends
 * the run. The end timestamp is pushed forward by one interval because a check
 * only tells us the service was failing at that moment; the outage is assumed
 * to last until the next successful probe.
 */
export function groupIncidents(
  downChecks: { serviceId: string; serviceName: string; ts: string }[],
  intervalMinutes: number,
  minConsecutive = 2,
): Incident[] {
  const intervalMs = intervalMinutes * 60_000;
  const tolerance = intervalMs * 1.5;
  const incidents: Incident[] = [];

  let run: { serviceId: string; serviceName: string; ts: string }[] = [];

  const flush = () => {
    if (run.length >= minConsecutive) {
      const first = run[0];
      const last = run[run.length - 1];
      const endMs = new Date(last.ts).getTime() + intervalMs;
      incidents.push({
        serviceId: first.serviceId,
        serviceName: first.serviceName,
        start: first.ts,
        end: new Date(endMs).toISOString().replace('.000Z', 'Z'),
        durationMinutes: Math.round((endMs - new Date(first.ts).getTime()) / 60_000),
        failedChecks: run.length,
      });
    }
    run = [];
  };

  for (const check of downChecks) {
    if (run.length === 0) {
      run = [check];
      continue;
    }
    const previous = run[run.length - 1];
    const sameService = previous.serviceId === check.serviceId;
    const contiguous = new Date(check.ts).getTime() - new Date(previous.ts).getTime() <= tolerance;

    if (sameService && contiguous) {
      run.push(check);
    } else {
      flush();
      run = [check];
    }
  }
  flush();

  return incidents.sort((a, b) => b.durationMinutes - a.durationMinutes);
}

/* ----------------------------------------------------------------- SQL --- */

interface OutcomeRow {
  service_id: string;
  service_name: string;
  up_checks: number;
  down_checks: number;
  unknown_checks: number;
}

interface LatencyRow {
  service_id: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  avg: number | null;
  max: number | null;
  samples: number;
  missing: number;
}

const OUTCOME_SQL = `
  SELECT service_id,
         MAX(service_name)                        AS service_name,
         SUM(outcome = 'up')                      AS up_checks,
         SUM(outcome = 'down')                    AS down_checks,
         SUM(outcome = 'unknown')                 AS unknown_checks
  FROM checks
  WHERE upload_id = ?1 AND day >= ?2 AND day <= ?3
  GROUP BY service_id
  ORDER BY service_id
`;

/**
 * Nearest-rank percentiles. SQLite has no percentile function, so each
 * latency is ranked within its service and the row at ceil(n * p / 100) is
 * picked. Percentiles rather than an average because one six-second outlier
 * moves an average and tells you nothing about what most users experienced.
 */
const LATENCY_SQL = `
  WITH sampled AS (
    SELECT service_id, latency_ms,
           ROW_NUMBER() OVER (PARTITION BY service_id ORDER BY latency_ms) AS rank_in_service,
           COUNT(*)     OVER (PARTITION BY service_id)                     AS sample_count
    FROM checks
    WHERE upload_id = ?1 AND day >= ?2 AND day <= ?3 AND latency_ms IS NOT NULL
  ),
  absent AS (
    SELECT service_id, COUNT(*) AS missing
    FROM checks
    WHERE upload_id = ?1 AND day >= ?2 AND day <= ?3 AND latency_ms IS NULL
    GROUP BY service_id
  )
  SELECT s.service_id,
         MAX(CASE WHEN s.rank_in_service = MAX(1, (s.sample_count * 50 + 99) / 100) THEN s.latency_ms END) AS p50,
         MAX(CASE WHEN s.rank_in_service = MAX(1, (s.sample_count * 95 + 99) / 100) THEN s.latency_ms END) AS p95,
         MAX(CASE WHEN s.rank_in_service = MAX(1, (s.sample_count * 99 + 99) / 100) THEN s.latency_ms END) AS p99,
         ROUND(AVG(s.latency_ms), 1) AS avg,
         MAX(s.latency_ms)           AS max,
         COUNT(*)                    AS samples,
         COALESCE(MAX(a.missing), 0) AS missing
  FROM sampled s
  LEFT JOIN absent a ON a.service_id = s.service_id
  GROUP BY s.service_id
`;

const DAILY_SQL = `
  SELECT service_id, day,
         SUM(outcome = 'up')   AS up_checks,
         SUM(outcome = 'down') AS down_checks
  FROM checks
  WHERE upload_id = ?1 AND day >= ?2 AND day <= ?3
  GROUP BY service_id, day
  ORDER BY day, service_id
`;

const DOWN_CHECKS_SQL = `
  SELECT service_id, service_name, ts
  FROM checks
  WHERE upload_id = ?1 AND day >= ?2 AND day <= ?3 AND outcome = 'down'
  ORDER BY service_id, ts
`;

export interface StatsResult {
  services: ServiceStats[];
  incidents: Incident[];
  daily: DailyPoint[];
  totals: {
    evaluatedChecks: number;
    downChecks: number;
    unknownChecks: number;
    availability: number | null;
    servicesBreaching: number;
    worstService: string | null;
  };
}

export async function computeStats(
  db: D1Database,
  uploadId: string,
  from: string,
  to: string,
  intervalMinutes: number,
): Promise<StatsResult> {
  const [outcomes, latencies, daily, downChecks] = await Promise.all([
    db.prepare(OUTCOME_SQL).bind(uploadId, from, to).all<OutcomeRow>(),
    db.prepare(LATENCY_SQL).bind(uploadId, from, to).all<LatencyRow>(),
    db.prepare(DAILY_SQL).bind(uploadId, from, to).all<{
      service_id: string;
      day: string;
      up_checks: number;
      down_checks: number;
    }>(),
    db.prepare(DOWN_CHECKS_SQL).bind(uploadId, from, to).all<{
      service_id: string;
      service_name: string;
      ts: string;
    }>(),
  ]);

  const latencyById = new Map<string, LatencyRow>();
  for (const row of latencies.results ?? []) latencyById.set(row.service_id, row);

  const services: ServiceStats[] = (outcomes.results ?? []).map((row) => {
    const evaluated = row.up_checks + row.down_checks;
    const availability = availabilityOf(row.up_checks, row.down_checks);
    const downtimeMinutes = row.down_checks * intervalMinutes;

    // The budget is the downtime the SLA tolerates over exactly this window,
    // so it shrinks when the user narrows the date filter.
    const windowMinutes = evaluated * intervalMinutes;
    const errorBudgetMinutes = windowMinutes * (1 - SLA_TARGET);

    const latency = latencyById.get(row.service_id);

    return {
      serviceId: row.service_id,
      serviceName: row.service_name,
      upChecks: row.up_checks,
      downChecks: row.down_checks,
      unknownChecks: row.unknown_checks,
      evaluatedChecks: evaluated,
      availability,
      meetsSla: availability === null ? null : availability >= SLA_TARGET,
      downtimeMinutes,
      errorBudgetMinutes: Math.round(errorBudgetMinutes * 10) / 10,
      errorBudgetUsedPct:
        errorBudgetMinutes > 0 ? (downtimeMinutes / errorBudgetMinutes) * 100 : null,
      latency: latency
        ? {
            p50: latency.p50,
            p95: latency.p95,
            p99: latency.p99,
            avg: latency.avg,
            max: latency.max,
            samples: latency.samples,
            missing: latency.missing,
          }
        : null,
    };
  });

  const incidents = groupIncidents(
    (downChecks.results ?? []).map((r) => ({
      serviceId: r.service_id,
      serviceName: r.service_name,
      ts: r.ts,
    })),
    intervalMinutes,
  );

  const totalUp = services.reduce((sum, s) => sum + s.upChecks, 0);
  const totalDown = services.reduce((sum, s) => sum + s.downChecks, 0);
  const breaching = services.filter((s) => s.meetsSla === false);
  const worst = [...services]
    .filter((s) => s.availability !== null)
    .sort((a, b) => (a.availability ?? 1) - (b.availability ?? 1))[0];

  return {
    services,
    incidents,
    daily: (daily.results ?? []).map((row) => ({
      serviceId: row.service_id,
      day: row.day,
      upChecks: row.up_checks,
      downChecks: row.down_checks,
      availability: availabilityOf(row.up_checks, row.down_checks),
    })),
    totals: {
      evaluatedChecks: totalUp + totalDown,
      downChecks: totalDown,
      unknownChecks: services.reduce((sum, s) => sum + s.unknownChecks, 0),
      availability: availabilityOf(totalUp, totalDown),
      servicesBreaching: breaching.length,
      worstService: worst?.serviceName ?? null,
    },
  };
}

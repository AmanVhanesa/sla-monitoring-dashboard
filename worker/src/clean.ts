/**
 * Cleaning and normalisation for raw monitoring-agent CSV rows.
 *
 * Everything in this file is a pure function of its inputs so it can be unit
 * tested without a database, a network, or a Worker runtime. The Worker calls
 * `cleanChunk` and does nothing else to the data.
 */

export type Outcome = 'up' | 'down' | 'unknown';

export interface CleanRow {
  serviceId: string;
  serviceName: string;
  ts: string; // ISO-8601 in UTC, always ending in Z
  day: string; // YYYY-MM-DD in UTC, denormalised so date filters stay index-friendly
  statusCode: number;
  outcome: Outcome;
  latencyMs: number | null;
  latencyRaw: string | null;
  latencyUnit: string | null;
  agent: string;
  region: string | null;
}

/** A row we could not trust enough to store, kept so the UI can show why. */
export interface RejectedRow {
  line: number;
  reason: string;
  raw: string;
}

export interface Counters {
  received: number;
  accepted: number;
  rejected: number;
  tsIsoUtc: number;
  tsOffset: number;
  tsEpoch: number;
  tsAssumedUtc: number;
  latencyConverted: number;
  latencyMissing: number;
  latencyNegative: number;
  latencyUnparseable: number;
  statusInvalid: number;
  outcomeUp: number;
  outcomeDown: number;
}

export function emptyCounters(): Counters {
  return {
    received: 0,
    accepted: 0,
    rejected: 0,
    tsIsoUtc: 0,
    tsOffset: 0,
    tsEpoch: 0,
    tsAssumedUtc: 0,
    latencyConverted: 0,
    latencyMissing: 0,
    latencyNegative: 0,
    latencyUnparseable: 0,
    statusInvalid: 0,
    outcomeUp: 0,
    outcomeDown: 0,
  };
}

export function addCounters(a: Counters, b: Counters): Counters {
  const out = emptyCounters();
  for (const key of Object.keys(out) as (keyof Counters)[]) out[key] = a[key] + b[key];
  return out;
}

/* ------------------------------------------------------------------ CSV --- */

/**
 * Minimal RFC-4180 field splitter. The supplied data has no quoted fields, but
 * a monitoring agent could legitimately emit one (a region name with a comma),
 * and silently splitting it would corrupt every column after it.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"'; // an escaped quote inside a quoted field
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

/* ------------------------------------------------------------ timestamps --- */

export type TimestampFormat = 'iso_utc' | 'iso_offset' | 'epoch' | 'assumed_utc';

export interface ParsedTimestamp {
  iso: string;
  day: string;
  format: TimestampFormat;
}

const EPOCH_SECONDS = /^\d{10}$/;
const EPOCH_MILLIS = /^\d{13}$/;
const HAS_OFFSET = /[+-]\d{2}:?\d{2}$/;
const ENDS_WITH_Z = /Z$/i;

/**
 * The agents emit three different timestamp encodings for the same clock:
 * ISO-8601 UTC, Unix epoch seconds, and ISO-8601 with a +05:30 offset.
 *
 * The offset case is the dangerous one. `2025-05-08T18:00:00+05:30` is
 * `12:30Z` - a different check slot, and on some rows a different calendar
 * day. Dropping the offset would quietly move checks between days and corrupt
 * per-day availability, so every timestamp is converted to UTC here and the
 * original encoding is counted for the data-quality report.
 */
export function parseTimestamp(raw: string): ParsedTimestamp | null {
  const value = (raw ?? '').trim();
  if (!value) return null;

  let date: Date;
  let format: TimestampFormat;

  if (EPOCH_SECONDS.test(value)) {
    date = new Date(Number(value) * 1000);
    format = 'epoch';
  } else if (EPOCH_MILLIS.test(value)) {
    date = new Date(Number(value));
    format = 'epoch';
  } else if (ENDS_WITH_Z.test(value)) {
    date = new Date(value);
    format = 'iso_utc';
  } else if (HAS_OFFSET.test(value)) {
    date = new Date(value);
    format = 'iso_offset';
  } else {
    // No zone marker at all. JavaScript would read this as *local* time, which
    // makes the result depend on where the code happens to run. We pin it to
    // UTC and flag it rather than inheriting the runtime's timezone.
    date = new Date(value + 'Z');
    format = 'assumed_utc';
  }

  if (Number.isNaN(date.getTime())) return null;

  // A parseable but absurd date (year 1970, year 3000) means a corrupt field,
  // not a real check.
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;

  const iso = date.toISOString().replace('.000Z', 'Z');
  return { iso, day: iso.slice(0, 10), format };
}

/* --------------------------------------------------------------- latency --- */

export type LatencyFlag = 'ok' | 'missing' | 'negative' | 'unparseable';

export interface ParsedLatency {
  ms: number | null;
  flag: LatencyFlag;
  converted: boolean;
}

/** Multipliers to milliseconds. Unknown units are treated as already-ms. */
const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  msec: 1,
  millis: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
};

/**
 * One service reports latency in seconds while the rest report milliseconds.
 * Without this conversion that service looks roughly 1000x faster than it is
 * and it would never trip a latency threshold.
 */
export function parseLatency(raw: string | undefined, unit: string | undefined): ParsedLatency {
  const value = (raw ?? '').trim();
  const unitKey = (unit ?? '').trim().toLowerCase();

  if (!value) return { ms: null, flag: 'missing', converted: false };

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { ms: null, flag: 'unparseable', converted: false };

  const multiplier = UNIT_TO_MS[unitKey] ?? 1;
  const ms = numeric * multiplier;

  // Latency is elapsed time; it cannot be negative. Treating it as a real
  // measurement would drag every average and percentile down.
  if (ms < 0) return { ms: null, flag: 'negative', converted: multiplier !== 1 };

  return { ms: round(ms, 3), flag: 'ok', converted: multiplier !== 1 };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/* ---------------------------------------------------------------- status --- */

export interface ParsedStatus {
  code: number;
  outcome: Outcome;
  valid: boolean;
}

/**
 * Availability rule: a service is "up" when it returned a valid HTTP response
 * that was not a server error. 5xx is the provider's fault and counts as down.
 *
 * Codes outside the HTTP range (the dataset contains 999) are not service
 * responses at all, they are the monitoring agent failing to complete a probe.
 * They are marked "unknown" and excluded from the availability ratio - see
 * README, "Data findings", for the evidence behind that decision.
 */
export function parseStatus(raw: string | undefined): ParsedStatus {
  const value = (raw ?? '').trim();
  const code = Number.parseInt(value, 10);

  if (!Number.isInteger(code) || code < 100 || code > 599) {
    return { code: Number.isInteger(code) ? code : -1, outcome: 'unknown', valid: false };
  }
  return { code, outcome: code >= 500 ? 'down' : 'up', valid: true };
}

/**
 * Which of two reports for the same check wins. A real failure outranks a
 * success, and both outrank an unusable reading. This is what resolves the
 * case where one agent reports 999 and the other reports 200 for the same
 * service at the same instant.
 */
export function precedence(outcome: Outcome): number {
  if (outcome === 'down') return 2;
  if (outcome === 'up') return 1;
  return 0;
}

/* ----------------------------------------------------------------- chunk --- */

export interface CleanResult {
  rows: CleanRow[];
  counters: Counters;
  rejected: RejectedRow[];
}

const REQUIRED_HEADERS = ['service_id', 'timestamp', 'status_code'];

/**
 * Clean one slice of the CSV. The browser splits the file on line boundaries
 * and sends each slice with the header attached; all parsing happens here, in
 * the Worker, so the client never has to be trusted with the data.
 */
export function cleanChunk(csvText: string, lineOffset = 0): CleanResult {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim() !== '');
  const counters = emptyCounters();
  const rows: CleanRow[] = [];
  const rejected: RejectedRow[] = [];

  if (lines.length === 0) return { rows, counters, rejected };

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  for (const required of REQUIRED_HEADERS) {
    if (!headers.includes(required)) {
      throw new Error(`CSV is missing the required "${required}" column`);
    }
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    counters.received++;

    const fields = splitCsvLine(line);
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = fields[index] ?? '';
    });

    const serviceId = record['service_id']?.trim();
    if (!serviceId) {
      counters.rejected++;
      rejected.push({ line: lineOffset + i, reason: 'missing service_id', raw: line });
      continue;
    }

    const timestamp = parseTimestamp(record['timestamp']);
    if (!timestamp) {
      counters.rejected++;
      rejected.push({ line: lineOffset + i, reason: 'unparseable timestamp', raw: line });
      continue;
    }

    const status = parseStatus(record['status_code']);
    const latency = parseLatency(record['latency'], record['latency_unit']);

    if (timestamp.format === 'iso_utc') counters.tsIsoUtc++;
    else if (timestamp.format === 'iso_offset') counters.tsOffset++;
    else if (timestamp.format === 'epoch') counters.tsEpoch++;
    else counters.tsAssumedUtc++;

    if (latency.converted) counters.latencyConverted++;
    if (latency.flag === 'missing') counters.latencyMissing++;
    if (latency.flag === 'negative') counters.latencyNegative++;
    if (latency.flag === 'unparseable') counters.latencyUnparseable++;
    if (!status.valid) counters.statusInvalid++;
    if (status.outcome === 'up') counters.outcomeUp++;
    if (status.outcome === 'down') counters.outcomeDown++;

    counters.accepted++;
    rows.push({
      serviceId,
      serviceName: record['service_name']?.trim() || serviceId,
      ts: timestamp.iso,
      day: timestamp.day,
      statusCode: status.code,
      outcome: status.outcome,
      latencyMs: latency.ms,
      latencyRaw: record['latency']?.trim() || null,
      latencyUnit: record['latency_unit']?.trim() || null,
      agent: record['agent']?.trim() || 'unknown',
      region: record['region']?.trim() || null,
    });
  }

  return { rows, counters, rejected };
}

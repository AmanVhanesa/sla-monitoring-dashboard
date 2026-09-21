export interface QualityReport {
  rowsReceived: number;
  rowsRejected: number;
  rowsStored: number;
  duplicatesCollapsed: number;
  timestampsIsoUtc: number;
  timestampsOffsetConverted: number;
  timestampsEpochConverted: number;
  timestampsAssumedUtc: number;
  latencyUnitConverted: number;
  latencyMissing: number;
  latencyNegative: number;
  latencyUnparseable: number;
  statusInvalid: number;
}

export interface Upload {
  id: string;
  filename: string;
  uploadedAt: string;
  status: string;
  windowStart: string | null;
  windowEnd: string | null;
  serviceCount: number;
  intervalMinutes: number;
  quality: QualityReport;
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

export interface StatsResponse {
  upload: Upload;
  range: { from: string; to: string };
  slaTarget: number;
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

export interface CheckRow {
  serviceId: string;
  serviceName: string;
  ts: string;
  statusCode: number;
  outcome: 'up' | 'down' | 'unknown';
  latencyMs: number | null;
  latencyRaw: string | null;
  latencyUnit: string | null;
  agent: string;
  region: string | null;
}

export interface LogsResponse {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  range: { from: string; to: string };
  rows: CheckRow[];
}

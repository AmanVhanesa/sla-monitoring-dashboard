import { useEffect, useState } from 'react';
import { fetchLogs } from '../api';
import type { CheckRow, LogsResponse, ServiceStats, Upload } from '../types';
import { formatInteger, formatMs, formatTimestamp } from '../format';

interface Props {
  upload: Upload;
  services: ServiceStats[];
}

type DateMode = 'single' | 'range';

function isSlow(row: CheckRow, thresholds: Map<string, number | null>): boolean {
  const threshold = thresholds.get(row.serviceId);
  return (
    row.outcome === 'up' && row.latencyMs !== null && threshold != null && row.latencyMs > threshold
  );
}

export function LogsSection({ upload, services }: Props) {
  const [mode, setMode] = useState<DateMode>('range');
  const [from, setFrom] = useState(upload.windowStart ?? '');
  const [to, setTo] = useState(upload.windowEnd ?? '');
  const [service, setService] = useState('');
  const [outcome, setOutcome] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LogsResponse | null>(null);

  // The thresholds come from the stats call rather than a second query: a
  // check that returned 200 but ran far slower than its service's median is
  // worth seeing in the log, because that is what a brownout looks like.
  const slowThresholds = new Map(
    services.map((entry) => [entry.serviceId, entry.slowThresholdMs]),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // In single-date mode both ends of the range are the same day, so the server
  // keeps one filtering path instead of two.
  const effectiveFrom = from;
  const effectiveTo = mode === 'single' ? from : to;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchLogs(upload.id, {
      from: effectiveFrom,
      to: effectiveTo,
      service,
      outcome,
      page,
      pageSize: 100,
    })
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [upload.id, effectiveFrom, effectiveTo, service, outcome, page]);

  // Any filter change invalidates the current page number.
  function update<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  return (
    <section className="panel">
      <div className="section-head">
        <h2>Check log</h2>
        <span className="muted">
          {data ? `${formatInteger(data.total)} matching checks` : 'loading…'}
        </span>
      </div>

      <div className="filters">
        <div className="field">
          <label htmlFor="date-mode">Filter by</label>
          <select
            id="date-mode"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as DateMode);
              setPage(1);
            }}
          >
            <option value="single">A single date</option>
            <option value="range">A date range</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="from">{mode === 'single' ? 'Date' : 'From'}</label>
          <input
            id="from"
            type="date"
            value={from}
            min={upload.windowStart ?? undefined}
            max={upload.windowEnd ?? undefined}
            onChange={(event) => update(setFrom)(event.target.value)}
          />
        </div>

        {mode === 'range' && (
          <div className="field">
            <label htmlFor="to">To</label>
            <input
              id="to"
              type="date"
              value={to}
              min={upload.windowStart ?? undefined}
              max={upload.windowEnd ?? undefined}
              onChange={(event) => update(setTo)(event.target.value)}
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="service">Service</label>
          <select
            id="service"
            value={service}
            onChange={(event) => update(setService)(event.target.value)}
          >
            <option value="">All services</option>
            {services.map((entry) => (
              <option key={entry.serviceId} value={entry.serviceId}>
                {entry.serviceName}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="outcome">Outcome</label>
          <select
            id="outcome"
            value={outcome}
            onChange={(event) => update(setOutcome)(event.target.value)}
          >
            <option value="">All outcomes</option>
            <option value="down">Failed only</option>
            <option value="up">Successful only</option>
            <option value="unknown">Unusable readings</option>
          </select>
        </div>

        <button
          className="ghost-button"
          onClick={() => {
            setFrom(upload.windowStart ?? '');
            setTo(upload.windowEnd ?? '');
            setService('');
            setOutcome('');
            setPage(1);
          }}
        >
          Reset
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="table-scroll table-scroll--tall">
        <table className="data-table">
          <thead>
            <tr>
              <th>Timestamp (UTC)</th>
              <th>Service</th>
              <th className="num">Status</th>
              <th>Outcome</th>
              <th className="num">Latency</th>
              <th>As reported</th>
              <th>Agent</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="muted center">
                  No checks match these filters.
                </td>
              </tr>
            )}
            {data?.rows.map((row) => (
              <tr key={`${row.serviceId}-${row.ts}`} className={`row--${row.outcome}`}>
                <td className="mono">{formatTimestamp(row.ts)}</td>
                <td>{row.serviceName}</td>
                <td className="num mono">{row.statusCode === -1 ? '--' : row.statusCode}</td>
                <td>
                  <span className={`pill pill--${row.outcome}`}>{row.outcome}</span>
                </td>
                <td className="num mono">
                  {formatMs(row.latencyMs)}
                  {isSlow(row, slowThresholds) && (
                    <span className="pill pill--unknown slow-tag" title="Succeeded, but far slower than this service's median">
                      slow
                    </span>
                  )}
                </td>
                <td className="muted mono">
                  {row.latencyRaw === null
                    ? 'blank'
                    : `${row.latencyRaw} ${row.latencyUnit ?? ''}`.trim()}
                </td>
                <td className="muted mono">{row.agent}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="loading-veil">Loading…</div>}
      </div>

      {data && data.totalPages > 1 && (
        <div className="pager">
          <button className="ghost-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="muted">
            Page {data.page} of {formatInteger(data.totalPages)}
          </span>
          <button
            className="ghost-button"
            disabled={page >= data.totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

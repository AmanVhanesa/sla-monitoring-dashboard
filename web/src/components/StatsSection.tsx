import { useState } from 'react';
import type { DailyPoint, StatsResponse } from '../types';
import {
  formatAvailability,
  formatDuration,
  formatInteger,
  formatMs,
  formatTimestamp,
} from '../format';

interface Props {
  stats: StatsResponse;
}

/**
 * The stats a person actually needs here is either an on-call engineer ("what
 * broke and for how long") or someone in billing ("does this window owe a
 * credit"). Every block below answers one of those two questions; anything
 * that answered neither was left out.
 */
export function StatsSection({ stats }: Props) {
  const [open, setOpen] = useState(true);
  const { totals, services, incidents, daily, slaTarget, upload } = stats;

  return (
    <section className="panel">
      <button className="section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`chevron ${open ? 'chevron--open' : ''}`} aria-hidden="true">
          ▶
        </span>
        <h2>Service health</h2>
        <span className="muted">
          {stats.range.from} to {stats.range.to} &middot; {formatInteger(totals.evaluatedChecks)}{' '}
          checks evaluated
        </span>
      </button>

      {open && (
        <div className="section-body">
          <HeadlineRow stats={stats} />

          <h3>
            Availability against a {(slaTarget * 100).toFixed(1)}% SLA
            <span className="muted"> &middot; a service below the line owes a billing credit</span>
          </h3>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th className="num">Availability</th>
                  <th className="num">Downtime</th>
                  <th>Error budget</th>
                  <th className="num">p50</th>
                  <th className="num">p95</th>
                  <th className="num">p99</th>
                  <th className="num">Checks</th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.serviceId}>
                    <td>
                      <div className="service-cell">
                        <strong>{service.serviceName}</strong>
                        <span className={`badge ${service.meetsSla ? 'badge--ok' : 'badge--bad'}`}>
                          {service.meetsSla ? 'Meets SLA' : 'Breach'}
                        </span>
                      </div>
                      <span className="muted mono">{service.serviceId}</span>
                    </td>
                    <td className="num mono">{formatAvailability(service.availability)}</td>
                    <td className="num">{formatDuration(service.downtimeMinutes)}</td>
                    <td>
                      <ErrorBudgetBar
                        usedPct={service.errorBudgetUsedPct}
                        budgetMinutes={service.errorBudgetMinutes}
                      />
                    </td>
                    <td className="num mono">{formatMs(service.latency?.p50 ?? null)}</td>
                    <td className="num mono">{formatMs(service.latency?.p95 ?? null)}</td>
                    <td className="num mono">{formatMs(service.latency?.p99 ?? null)}</td>
                    <td className="num mono">{formatInteger(service.evaluatedChecks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="split">
            <div>
              <h3>
                Incidents
                <span className="muted"> &middot; two or more consecutive failed checks</span>
              </h3>
              {incidents.length === 0 ? (
                <p className="muted">
                  No sustained outage in this window. Isolated failures are treated as noise and
                  still appear in the log below.
                </p>
              ) : (
                <ul className="incident-list">
                  {incidents.map((incident) => (
                    <li key={`${incident.serviceId}-${incident.start}`}>
                      <div className="incident-head">
                        <strong>{incident.serviceName}</strong>
                        <span className="badge badge--bad">
                          {formatDuration(incident.durationMinutes)}
                        </span>
                      </div>
                      <span className="muted mono">
                        {formatTimestamp(incident.start)} &rarr; {formatTimestamp(incident.end)}
                      </span>
                      <span className="muted">{incident.failedChecks} failed checks</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3>
                Daily availability
                <span className="muted"> &middot; each bar is one UTC day</span>
              </h3>
              <DailyChart daily={daily} services={services.map((s) => s.serviceId)} />
            </div>
          </div>

          <h3>
            Data quality
            <span className="muted"> &middot; what the cloud function changed before storing</span>
          </h3>
          <QualityGrid upload={upload} unknownChecks={totals.unknownChecks} />
        </div>
      )}
    </section>
  );
}

function HeadlineRow({ stats }: Props) {
  const { totals, services, incidents } = stats;
  const totalDowntime = services.reduce((sum, s) => sum + s.downtimeMinutes, 0);

  return (
    <div className="headline-row">
      <Metric
        label="Fleet availability"
        value={formatAvailability(totals.availability)}
        tone={totals.availability !== null && totals.availability >= stats.slaTarget ? 'ok' : 'bad'}
        note={`${formatInteger(totals.downChecks)} failed checks`}
      />
      <Metric
        label="Services owing credit"
        value={`${totals.servicesBreaching} of ${services.length}`}
        tone={totals.servicesBreaching === 0 ? 'ok' : 'bad'}
        note={totals.worstService ? `worst: ${totals.worstService}` : 'all within target'}
      />
      <Metric
        label="Total downtime"
        value={formatDuration(totalDowntime)}
        tone="neutral"
        note={`${stats.upload.intervalMinutes} min per failed check`}
      />
      <Metric
        label="Incidents"
        value={String(incidents.length)}
        tone={incidents.length === 0 ? 'ok' : 'warn'}
        note={incidents.length ? `longest ${formatDuration(incidents[0].durationMinutes)}` : 'none'}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone: 'ok' | 'bad' | 'warn' | 'neutral';
}) {
  return (
    <div className={`metric metric--${tone}`}>
      <span className="metric__label">{label}</span>
      <strong className="metric__value">{value}</strong>
      <span className="metric__note">{note}</span>
    </div>
  );
}

/**
 * Error budget is the downtime the SLA allows over this window. Showing it as
 * a share consumed is more actionable than a raw percentage: "68% of the
 * month's budget is gone" tells you whether to ship on Friday.
 */
function ErrorBudgetBar({
  usedPct,
  budgetMinutes,
}: {
  usedPct: number | null;
  budgetMinutes: number;
}) {
  if (usedPct === null) return <span className="muted">--</span>;
  const clamped = Math.min(usedPct, 100);
  const tone = usedPct >= 100 ? 'bad' : usedPct >= 75 ? 'warn' : 'ok';

  return (
    <div className="budget">
      <div className="budget__track">
        <div className={`budget__fill budget__fill--${tone}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="muted mono">
        {usedPct >= 1000 ? '>1000' : Math.round(usedPct)}% of {formatDuration(budgetMinutes)}
      </span>
    </div>
  );
}

/**
 * Hand-drawn SVG rather than a charting dependency: one bar per service per
 * day, coloured by whether that day alone would have met the SLA.
 */
function DailyChart({ daily, services }: { daily: DailyPoint[]; services: string[] }) {
  const days = [...new Set(daily.map((point) => point.day))].sort();
  if (days.length === 0) return <p className="muted">No data in this window.</p>;

  const byService = new Map<string, DailyPoint[]>();
  for (const id of services) {
    byService.set(
      id,
      days.map(
        (day) =>
          daily.find((point) => point.serviceId === id && point.day === day) ?? {
            serviceId: id,
            day,
            upChecks: 0,
            downChecks: 0,
            availability: null,
          },
      ),
    );
  }

  return (
    <div className="daily-chart">
      {[...byService.entries()].map(([serviceId, points]) => (
        <div className="daily-row" key={serviceId}>
          <span className="daily-row__label mono">{serviceId.replace('svc-', '')}</span>
          <div className="daily-row__bars">
            {points.map((point) => {
              // Anchored at 95% so a 99.9% day and a 99.0% day look different.
              // Anchoring at 0 would make every bar look identically full.
              const availability = point.availability ?? 1;
              const height = Math.max(4, Math.min(100, ((availability - 0.95) / 0.05) * 100));
              const tone = point.availability === null ? 'none' : availability >= 0.999 ? 'ok' : 'bad';
              return (
                <div
                  key={point.day}
                  className={`daily-bar daily-bar--${tone}`}
                  style={{ height: `${height}%` }}
                  title={`${point.day}: ${formatAvailability(point.availability)} (${point.downChecks} failed)`}
                />
              );
            })}
          </div>
        </div>
      ))}
      <div className="daily-axis muted mono">
        <span>{days[0]}</span>
        <span>{days[days.length - 1]}</span>
      </div>
    </div>
  );
}

/**
 * The brief opens with "the pipeline that turns raw logs into numbers has to
 * be trustworthy". A number with no provenance is not trustworthy, so the
 * cleaning the function performed is shown next to the result it produced.
 */
function QualityGrid({
  upload,
  unknownChecks,
}: {
  upload: StatsResponse['upload'];
  unknownChecks: number;
}) {
  const q = upload.quality;
  const entries: { label: string; value: number; hint: string }[] = [
    {
      label: 'Rows read from file',
      value: q.rowsReceived,
      hint: 'data lines the function parsed',
    },
    {
      label: 'Duplicate reports collapsed',
      value: q.duplicatesCollapsed,
      hint: 'two agents reporting the same probe count once',
    },
    {
      label: 'Distinct checks stored',
      value: q.rowsStored,
      hint: 'the denominator every percentage uses',
    },
    {
      label: 'Timestamps converted to UTC',
      value: q.timestampsEpochConverted + q.timestampsOffsetConverted + q.timestampsAssumedUtc,
      hint: `${q.timestampsEpochConverted} epoch, ${q.timestampsOffsetConverted} offset, ${q.timestampsAssumedUtc} zoneless`,
    },
    {
      label: 'Latencies converted to ms',
      value: q.latencyUnitConverted,
      hint: 'one service reports in seconds',
    },
    {
      label: 'Latencies discarded',
      value: q.latencyMissing + q.latencyNegative + q.latencyUnparseable,
      hint: `${q.latencyMissing} blank, ${q.latencyNegative} negative, ${q.latencyUnparseable} non-numeric`,
    },
    {
      label: 'Non-HTTP status codes',
      value: q.statusInvalid,
      hint: `${unknownChecks} left in the window, excluded from availability`,
    },
    {
      label: 'Rows rejected outright',
      value: q.rowsRejected,
      hint: 'no service id or an unreadable timestamp',
    },
  ];

  return (
    <div className="quality-grid">
      {entries.map((entry) => (
        <div className="quality-cell" key={entry.label}>
          <strong className="mono">{formatInteger(entry.value)}</strong>
          <span>{entry.label}</span>
          <span className="muted">{entry.hint}</span>
        </div>
      ))}
    </div>
  );
}

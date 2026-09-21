import { useCallback, useEffect, useState } from 'react';
import { API_BASE, fetchStats, listUploads } from './api';
import { UploadPanel } from './components/UploadPanel';
import { StatsSection } from './components/StatsSection';
import { LogsSection } from './components/LogsSection';
import type { StatsResponse, Upload } from './types';

export default function App() {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The dashboard reads everything back out of the database, so a refresh
  // shows the same numbers - nothing lives in the page's memory.
  const refreshUploads = useCallback(async (preferId?: string) => {
    const { uploads: rows } = await listUploads();
    const usable = rows.filter((upload) => upload.status === 'complete');
    setUploads(usable);
    setSelectedId((current) => preferId ?? current ?? usable[0]?.id ?? null);
    return usable;
  }, []);

  useEffect(() => {
    refreshUploads()
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false));
  }, [refreshUploads]);

  useEffect(() => {
    if (!selectedId) {
      setStats(null);
      return;
    }
    let cancelled = false;
    fetchStats(selectedId)
      .then((response) => {
        if (!cancelled) setStats(response);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  if (!API_BASE) {
    return (
      <main className="shell">
        <p className="error">
          VITE_API_BASE is not set, so this build has no cloud function to talk to. See the README.
        </p>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <h1>SLA Monitoring</h1>
          <p className="muted">
            Health-check logs, cleaned in a Cloudflare Worker and measured against a 99.9%
            availability target.
          </p>
        </div>
        {uploads.length > 0 && (
          <div className="field">
            <label htmlFor="dataset">Dataset</label>
            <select
              id="dataset"
              value={selectedId ?? ''}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {uploads.map((upload) => (
                <option key={upload.id} value={upload.id}>
                  {upload.filename} — {upload.windowStart} to {upload.windowEnd}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>

      <UploadPanel
        onUploaded={(upload) => {
          setError(null);
          void refreshUploads(upload.id);
        }}
      />

      {error && <p className="error">{error}</p>}

      {loading && <p className="muted">Loading…</p>}

      {!loading && uploads.length === 0 && (
        <section className="panel empty">
          <h2>Nothing uploaded yet</h2>
          <p className="muted">
            Upload a monitoring CSV above. The function will parse and clean it, store the result,
            and this page will read it back from the database.
          </p>
        </section>
      )}

      {stats && (
        <>
          <StatsSection stats={stats} />
          <LogsSection upload={stats.upload} services={stats.services} />
        </>
      )}

      <footer className="muted">
        Availability excludes readings whose status code is not a valid HTTP response, because those
        record a failed probe rather than a failed service.
      </footer>
    </main>
  );
}

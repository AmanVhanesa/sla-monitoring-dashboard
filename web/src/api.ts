import type { LogsResponse, StatsResponse, Upload } from './types';

/**
 * The API base is injected at build time. It points at the deployed Worker,
 * which is a different origin from this page - the UI is static hosting and
 * holds no logic beyond talking to that function.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Rows per request. The Worker is on Cloudflare's free tier, which caps CPU
 * time per invocation, so the file is delivered in slices rather than as one
 * body. Each slice is an independent, retryable request - which is what makes
 * the function genuinely stateless - and it gives the UI real progress.
 */
const ROWS_PER_CHUNK = 500;

export interface UploadProgress {
  sent: number;
  total: number;
}

/**
 * Note what the browser does and does not do here: it splits the file on line
 * boundaries and forwards the header with each slice. It never parses a field,
 * converts a unit, or decides what a row means. All of that happens in the
 * cloud function, so the numbers cannot be influenced by the client.
 */
export async function uploadCsv(
  file: File,
  onProgress: (progress: UploadProgress) => void,
): Promise<Upload> {
  const text = await file.text();
  const lines = text.split(/\r?\n/);
  const header = lines[0];
  const dataLines = lines.slice(1).filter((line) => line.trim() !== '');

  if (!header?.trim()) throw new Error('That file has no header row.');
  if (dataLines.length === 0) throw new Error('That file has a header but no data rows.');

  const { uploadId } = await request<{ uploadId: string }>('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name }),
  });

  for (let index = 0; index < dataLines.length; index += ROWS_PER_CHUNK) {
    const slice = dataLines.slice(index, index + ROWS_PER_CHUNK);
    await request(`/api/uploads/${uploadId}/chunk?lineOffset=${index + 1}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: `${header}\n${slice.join('\n')}`,
    });
    onProgress({ sent: index + slice.length, total: dataLines.length });
  }

  const { upload } = await request<{ upload: Upload }>(`/api/uploads/${uploadId}/complete`, {
    method: 'POST',
  });
  return upload;
}

export function listUploads() {
  return request<{ uploads: Upload[] }>('/api/uploads');
}

export function fetchStats(uploadId: string, from?: string, to?: string) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return request<StatsResponse>(`/api/uploads/${uploadId}/stats?${params}`);
}

export function fetchLogs(
  uploadId: string,
  options: {
    from?: string;
    to?: string;
    service?: string;
    outcome?: string;
    page?: number;
    pageSize?: number;
  },
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return request<LogsResponse>(`/api/uploads/${uploadId}/logs?${params}`);
}

/** Shared formatting so the same number never appears two different ways. */

export function formatAvailability(value: number | null): string {
  if (value === null) return '--';
  // Three decimals, because the SLA line itself sits at the third decimal:
  // rounding 99.94% to 99.9% would hide a breach.
  return `${(value * 100).toFixed(3)}%`;
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return 'none';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = Math.round(minutes % 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(' ');
}

export function formatMs(value: number | null): string {
  if (value === null || value === undefined) return '--';
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

export function formatTimestamp(iso: string): string {
  return iso.replace('T', ' ').replace('Z', ' UTC');
}

export function formatInteger(value: number): string {
  return value.toLocaleString('en-US');
}

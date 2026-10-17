// Google's docs say free-tier daily quotas reset at midnight Pacific time. The API's own retry
// hints are preferred when present (see background/translate.ts).
const PACIFIC = 'America/Los_Angeles';

const pacificParts = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function wallClock(ms: number) {
  const parts: Record<string, number> = {};
  for (const p of pacificParts.formatToParts(ms)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return parts as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** "YYYY-MM-DD" of the Pacific-time day containing `ms`. */
export function pacificDay(ms = Date.now()): string {
  const { year, month, day } = wallClock(ms);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The first instant after `ms` at which it is 00:00 in Pacific time. */
export function nextPacificMidnight(ms = Date.now()): number {
  const { year, month, day } = wallClock(ms);
  // Pacific time is UTC−7 (PDT) or UTC−8 (PST); try both and keep the one that lands on midnight.
  for (const offsetHours of [7, 8]) {
    const candidate = Date.UTC(year, month - 1, day + 1, offsetHours);
    const w = wallClock(candidate);
    if (w.hour === 0 && w.minute === 0 && candidate > ms) return candidate;
  }
  return ms + 24 * 3600_000; // unreachable in practice
}

/** "YYYY-MM-DD" of the local day; chunk selection reshuffles when it changes. */
export function localDay(ms = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  if (ms < 60_000) return `${Math.max(1, Math.ceil(ms / 1000))}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

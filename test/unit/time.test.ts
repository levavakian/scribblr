import { describe, expect, it } from 'vitest';
import { formatDuration, nextPacificMidnight, pacificDay } from '../../src/shared/time';

const at = (iso: string) => Date.parse(iso);
const next = (iso: string) => new Date(nextPacificMidnight(at(iso))).toISOString();

describe('Pacific time', () => {
  it('finds the next midnight in daylight time and standard time', () => {
    expect(next('2026-10-17T10:00:00Z')).toBe('2026-10-18T07:00:00.000Z'); // 03:00 PDT
    expect(next('2026-12-01T20:00:00Z')).toBe('2026-12-02T08:00:00.000Z'); // 12:00 PST
  });

  it('handles the days the clocks change', () => {
    expect(next('2026-11-01T06:00:00Z')).toBe('2026-11-01T07:00:00.000Z'); // 23:00 PDT, Oct 31
    expect(next('2026-11-01T12:00:00Z')).toBe('2026-11-02T08:00:00.000Z'); // 04:00 PST, Nov 1
    expect(next('2026-03-07T20:00:00Z')).toBe('2026-03-08T08:00:00.000Z'); // 12:00 PST, Mar 7
    expect(next('2026-03-08T12:00:00Z')).toBe('2026-03-09T07:00:00.000Z'); // 05:00 PDT, Mar 8
  });

  it('is strictly in the future at midnight itself', () => {
    expect(next('2026-10-18T07:00:00Z')).toBe('2026-10-19T07:00:00.000Z');
  });

  it('names the Pacific day', () => {
    expect(pacificDay(at('2026-10-17T05:00:00Z'))).toBe('2026-10-16');
    expect(pacificDay(at('2026-10-17T08:00:00Z'))).toBe('2026-10-17');
  });

  it('formats durations', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(5 * 60_000)).toBe('5m');
    expect(formatDuration(3 * 3600_000 + 61_000)).toBe('3h 2m');
  });
});

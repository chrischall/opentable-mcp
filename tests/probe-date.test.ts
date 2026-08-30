import { describe, it, expect } from 'vitest';
import { PROBE_LEAD_DAYS, localDateInDays, probeDate } from '../scripts/probe-date.js';

// Every `now` below is built from LOCAL components, and every assertion is a
// LOCAL calendar date, so these hold in any TZ the suite runs in.

describe('localDateInDays', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(localDateInDays(0, new Date(2026, 7, 27, 12, 0))).toBe('2026-08-27');
    expect(probeDate(new Date(2026, 7, 27, 12, 0))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('zero-pads single-digit months and days', () => {
    expect(localDateInDays(0, new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05');
  });

  it('adds the requested number of days', () => {
    expect(localDateInDays(14, new Date(2026, 7, 27, 12, 0))).toBe('2026-09-10');
  });

  it('rolls over a month boundary', () => {
    expect(localDateInDays(5, new Date(2026, 7, 30, 12, 0))).toBe('2026-09-04');
  });

  it('rolls over a year boundary', () => {
    expect(localDateInDays(1, new Date(2026, 11, 31, 12, 0))).toBe('2027-01-01');
    expect(localDateInDays(14, new Date(2026, 11, 25, 12, 0))).toBe('2027-01-08');
  });

  it('handles a leap day', () => {
    // 2028 is a leap year: Feb 28 + 1 = Feb 29, and +2 = Mar 1.
    expect(localDateInDays(1, new Date(2028, 1, 28, 12, 0))).toBe('2028-02-29');
    expect(localDateInDays(2, new Date(2028, 1, 28, 12, 0))).toBe('2028-03-01');
    // 2027 is not: Feb 28 + 1 = Mar 1.
    expect(localDateInDays(1, new Date(2027, 1, 28, 12, 0))).toBe('2027-03-01');
  });

  it('supports negative offsets', () => {
    expect(localDateInDays(-1, new Date(2026, 0, 1, 12, 0))).toBe('2025-12-31');
  });

  // The regression this helper exists for. At 23:30 local on Dec 31, a
  // UTC-based implementation (`toISOString().slice(0,10)`) returns
  // '2027-01-01' in every negative-UTC-offset zone — the Americas — sending
  // the probe at the wrong service day. Reading local components must not.
  it('uses the LOCAL calendar date, not the UTC one, late in the day', () => {
    expect(localDateInDays(0, new Date(2026, 11, 31, 23, 30))).toBe('2026-12-31');
    expect(localDateInDays(0, new Date(2026, 7, 27, 23, 59))).toBe('2026-08-27');
  });

  // ...and the mirror case: early morning in a positive-offset zone (Asia,
  // Europe in summer), where UTC is still on the previous day.
  it('uses the LOCAL calendar date early in the day', () => {
    expect(localDateInDays(0, new Date(2026, 0, 1, 0, 15))).toBe('2026-01-01');
  });
});

describe('probeDate', () => {
  it('is today + PROBE_LEAD_DAYS', () => {
    const now = new Date(2026, 7, 27, 12, 0);
    expect(probeDate(now)).toBe(localDateInDays(PROBE_LEAD_DAYS, now));
    expect(probeDate(now)).toBe('2026-09-10');
  });

  it('is always in the future, never a stale literal', () => {
    // The bug this replaces: a hardcoded date that drifts into the past.
    const today = localDateInDays(0);
    expect(probeDate() > today).toBe(true);
    expect(PROBE_LEAD_DAYS).toBeGreaterThan(0);
  });
});

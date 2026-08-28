// Shared date helper for the probe scripts.
//
// The probes used to pin `date: '2026-05-01'`. That was a live date when it
// was written and silently rotted into the past, after which `find_slots`
// returned `[]` forever — a probe that always "succeeds" while proving
// nothing. Dates are now computed relative to the run.
//
// TIMEZONE SAFETY. The obvious one-liner is wrong:
//
//     new Date().toISOString().slice(0, 10)   // ← DON'T
//
// `toISOString()` is UTC. Run it at 20:00 in New York and it returns
// TOMORROW's date, so the probe asks OpenTable for the wrong service day —
// and worst case books a table a day off. A reservation date is a *local
// calendar* date, so we read local components instead.
//
// The intermediate Date is anchored at 12:00 local rather than midnight so a
// DST transition (which moves the clock by an hour, and in a few zones lands
// exactly on midnight) can't push the computed day across a boundary.
// `Date`'s constructor normalises out-of-range day numbers, so month, year,
// and leap-day rollover all come for free.

/** How far ahead probes look. Far enough to be inside most venues' booking
 *  windows, near enough to stay inside `maxAdvanceDays` (often 30). */
export const PROBE_LEAD_DAYS = 14;

/**
 * `YYYY-MM-DD`, `days` from `now`, in the **local** calendar.
 *
 * @param days How many days ahead (negative works, and is used by tests).
 * @param now  Injectable clock so the behaviour is testable without mocking
 *             global time.
 */
export function localDateInDays(days: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 12, 0, 0, 0);
  const year = String(d.getFullYear()).padStart(4, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The date probes should ask about: today + {@link PROBE_LEAD_DAYS}. */
export function probeDate(now: Date = new Date()): string {
  return localDateInDays(PROBE_LEAD_DAYS, now);
}

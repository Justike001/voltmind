/**
 * Shared YYYY-MM-DD (UTC) date helpers.
 *
 * VoltMind routinely needs a plain `YYYY-MM-DD` string — for file names,
 * changelog entries, cache keys, and DB date columns. That idiom was
 * historically inlined as `x.toISOString().slice(0, 10)` in 40+ places,
 * plus three private re-implementations: `toISODate` (trajectory.ts and
 * trajectory-format.ts) and `todayUtc` (facts/forget.ts). Any drift in the
 * formatting required touching every call site by hand.
 *
 * Both helpers here are pure and behavior-identical to those originals:
 * they return the Date's **UTC** `YYYY-MM-DD` component. This is NOT the
 * local-calendar date (which would need getFullYear/getMonth/getDate).
 * Keep it that way — switching to local-time semantics here would silently
 * change every downstream consumer.
 */

/** Format an arbitrary Date as its UTC `YYYY-MM-DD` component. */
export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today's UTC `YYYY-MM-DD` (equivalent to `toISODate(new Date())`). */
export function todayISO(): string {
  return toISODate(new Date());
}

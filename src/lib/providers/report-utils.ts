/** Shared date/aggregation helpers for the daily-bucket report providers (OpenAI, Anthropic API). */

/**
 * Start of the current month (UTC) as unix seconds.
 *
 * @param nowMs current time (ms)
 * @returns unix seconds
 */
export function monthStartUnix(nowMs: number): number {
  const now = new Date(nowMs);
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
}

/**
 * Start of the current month (UTC) as an ISO timestamp.
 *
 * @param nowMs current time (ms)
 * @returns ISO string
 */
export function monthStartIso(nowMs: number): string {
  return new Date(monthStartUnix(nowMs) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Whether a bucket start (unix seconds or ISO string) falls on today (UTC).
 *
 * @param bucketStart the bucket's start
 * @param nowMs current time (ms)
 * @returns true when the bucket is today's
 */
export function isToday(bucketStart: unknown, nowMs: number): boolean {
  let date: Date;
  if (typeof bucketStart === "number") {
    date = new Date(bucketStart * 1000);
  } else if (typeof bucketStart === "string" && bucketStart) {
    date = new Date(bucketStart);
  } else {
    return false;
  }
  const now = new Date(nowMs);
  return (
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate()
  );
}

/**
 * Project the month-end spend from the spend so far: linear on elapsed days (UTC).
 *
 * @param monthSum spend since the 1st
 * @param nowMs current time (ms)
 * @returns the projected month total, rounded to cents
 */
export function projectMonth(monthSum: number, nowMs: number): number {
  const now = new Date(nowMs);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = now.getUTCDate();
  return Math.round((monthSum / dayOfMonth) * daysInMonth * 100) / 100;
}

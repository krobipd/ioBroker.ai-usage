/** Shared date/aggregation helpers for the daily-bucket report providers (OpenAI, Anthropic API). */
import type { JsonFetch } from "../http";

/**
 * How many pages a bucketed report may take before we stop asking.
 *
 * A month holds at most 31 daily buckets, and neither API is guaranteed to honour
 * our page size — so the ceiling is one page per possible bucket plus one. The
 * previous value was 12 while the comment argued with 31: a server paging in small
 * steps would have had the month silently cut off around day 12, and an
 * under-reported cost figure is the worst thing a cost monitor can produce.
 */
const MAX_REPORT_PAGES = 32;

/**
 * Fetch all pages of a bucketed report.
 *
 * Both report APIs page the same way (`has_more` + `next_page`, appended as `page`).
 * The loop is bounded as a backstop against a server that keeps saying "more" — and
 * when that backstop actually bites, it SAYS so instead of handing back a partial
 * month dressed up as a complete one.
 *
 * @param url the report URL without the page parameter
 * @param headers request headers
 * @param fetchJson the JSON-GET seam
 * @param onTruncated called when the page ceiling cut the report short
 * @returns all bucket entries
 */
export async function fetchAllPages(
  url: string,
  headers: Record<string, string>,
  fetchJson: JsonFetch,
  onTruncated?: (pages: number) => void,
): Promise<unknown[]> {
  const buckets: unknown[] = [];
  let page: string | undefined;
  for (let i = 0; i < MAX_REPORT_PAGES; i++) {
    const body = (await fetchJson(page ? `${url}&page=${encodeURIComponent(page)}` : url, headers)) as {
      data?: unknown;
      has_more?: unknown;
      next_page?: unknown;
    } | null;
    if (Array.isArray(body?.data)) {
      buckets.push(...body.data);
    }
    if (body?.has_more !== true || typeof body?.next_page !== "string" || !body.next_page) {
      return buckets;
    }
    page = body.next_page;
  }
  // Left the loop with the server still offering more: the numbers below are a
  // partial month. Say it out loud rather than reporting a wrong total in silence.
  onTruncated?.(MAX_REPORT_PAGES);
  return buckets;
}

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

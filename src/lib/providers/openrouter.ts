import { getJson, type JsonFetch } from "../http";
import { FetchError, type UsageProvider, type UsageSnapshot } from "../provider";
import { finiteNumber, round2 } from "../pure-helpers";
import { projectMonth } from "./report-utils";

/**
 * The key-info endpoint of the current OpenRouter API reference (`GET /api/v1/key`,
 * openapi.json 2026-09-25). The adapter called `/api/v1/auth/key` before, a path the
 * reference no longer carries (it still answered, measured 2026-09-25) — and the
 * one that does not document the daily and monthly usage read below.
 */
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

/**
 * Parse an OpenRouter `GET /api/v1/key` response into a snapshot.
 *
 * `usage` is the key's LIFETIME spend in USD. `limit` and `limit_remaining` are the
 * spending limit of the running limit period — `limit_reset` restarts it daily,
 * weekly or monthly. The percentage used to set the lifetime spend against the
 * period's limit: a key with a 100 $ monthly limit and 250 $ spent over its life
 * read as 250 % — `limitReached` and the warning on for good while 80 % of the
 * month was still free (decision 94). What the limit is measured against is the
 * period's use, `limit − limit_remaining`; the lifetime figure stays in
 * `costs.total`, the one datapoint that says it counts over the key's life.
 *
 * `usage_daily` and `usage_monthly` are "credit usage (in USD) for the current UTC
 * day/month" (API reference) — spend of this key, feeding `costs.today`/`.month`
 * and with them `total.costs` (decision 95).
 *
 * @param body the response body
 * @param nowMs current time (ms), for the month-end projection
 * @returns the snapshot
 */
export function parseOpenRouterKeyInfo(body: unknown, nowMs: number = Date.now()): UsageSnapshot {
  const data = (body as { data?: unknown } | null)?.data;
  if (typeof data !== "object" || data === null) {
    // "service": OpenRouter answered, we just cannot read it — not "no connection".
    throw new FetchError("service", "unexpected response shape (no data object)");
  }
  const info = data as Record<string, unknown>;
  const lifetime = finiteNumber(info.usage ?? info.credits_used);
  const limit = finiteNumber(info.limit ?? info.credit_limit);
  const limitRemaining = finiteNumber(info.limit_remaining);
  // Measured against the limit: what the running period used up, where OpenRouter
  // says what is left of it; without that figure only the lifetime is known.
  const used =
    limit !== undefined && limitRemaining !== undefined ? round2(Math.max(0, limit - limitRemaining)) : lifetime;
  const remaining = limitRemaining ?? (used !== undefined && limit !== undefined ? round2(limit - used) : undefined);
  const percent = used !== undefined && limit !== undefined && limit > 0 ? round2((used / limit) * 100) : undefined;
  const snapshot: UsageSnapshot = {};
  // Only when there is something to say. The block used to be a plain object
  // literal, so it was always present — an answer without a single usable figure
  // still created an empty `credits` channel in the tree (decision 6: a capability
  // without a usable value gets no datapoint).
  if (used !== undefined || limit !== undefined || remaining !== undefined || percent !== undefined) {
    snapshot.credits = { used, limit, remaining, percent, currency: "USD" };
  }
  const today = finiteNumber(info.usage_daily);
  const month = finiteNumber(info.usage_monthly);
  if (lifetime !== undefined || today !== undefined || month !== undefined) {
    snapshot.costs = { currency: "USD" };
    if (lifetime !== undefined) {
      snapshot.costs.total = lifetime;
    }
    if (today !== undefined) {
      snapshot.costs.today = round2(today);
    }
    if (month !== undefined) {
      snapshot.costs.month = round2(month);
      snapshot.costs.projectedMonth = projectMonth(month, nowMs);
    }
  }
  return snapshot;
}

/**
 * The OpenRouter provider: reads the key info (credits used/limit/remaining).
 *
 * @param apiKey the OpenRouter API key
 * @param fetchJson the JSON-GET seam (tests inject a fake)
 * @param now clock (ms) — injected for tests
 * @param userAgent the adapter's own identity for this request
 * @returns the provider
 */
export function openRouterProvider(
  apiKey: string,
  fetchJson: JsonFetch = getJson,
  now: () => number = Date.now,
  userAgent?: string,
): UsageProvider {
  return {
    kind: "openrouter",
    fetch: async (): Promise<UsageSnapshot> =>
      parseOpenRouterKeyInfo(
        await fetchJson(OPENROUTER_KEY_URL, {
          Authorization: `Bearer ${apiKey}`,
          ...(userAgent ? { "User-Agent": userAgent } : {}),
        }),
        now(),
      ),
  };
}

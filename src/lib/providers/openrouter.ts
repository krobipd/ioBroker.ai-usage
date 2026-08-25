import { getJson, type JsonFetch } from "../http";
import { FetchError, type UsageProvider, type UsageSnapshot } from "../provider";

/**
 * Parse an OpenRouter `GET /api/v1/auth/key` response into a snapshot. The key info
 * carries lifetime usage in dollars and an optional credit ceiling. Field names are
 * read defensively (`usage`/`limit` per the API reference, `credits_used`/
 * `credit_limit` as seen in community captures).
 *
 * @param body the response body
 * @returns the snapshot
 */
export function parseOpenRouterKeyInfo(body: unknown): UsageSnapshot {
  const data = (body as { data?: unknown } | null)?.data;
  if (typeof data !== "object" || data === null) {
    throw new FetchError("network", "unexpected response shape (no data object)");
  }
  const info = data as Record<string, unknown>;
  const used = numberOrUndefined(info.usage ?? info.credits_used);
  const limit = numberOrUndefined(info.limit ?? info.credit_limit);
  const remaining =
    numberOrUndefined(info.limit_remaining) ??
    (used !== undefined && limit !== undefined ? round2(limit - used) : undefined);
  const snapshot: UsageSnapshot = {
    credits: {
      used,
      limit,
      remaining,
      percent: used !== undefined && limit !== undefined && limit > 0 ? round2((used / limit) * 100) : undefined,
      currency: "USD",
    },
  };
  if (used !== undefined) {
    snapshot.costs = { total: used, currency: "USD" };
  }
  return snapshot;
}

/**
 * The OpenRouter provider: reads the key info (credits used/limit/remaining).
 *
 * @param apiKey the OpenRouter API key
 * @param fetchJson the JSON-GET seam (tests inject a fake)
 * @returns the provider
 */
export function openRouterProvider(apiKey: string, fetchJson: JsonFetch = getJson): UsageProvider {
  return {
    kind: "openrouter",
    fetch: async (): Promise<UsageSnapshot> =>
      parseOpenRouterKeyInfo(
        await fetchJson("https://openrouter.ai/api/v1/auth/key", { Authorization: `Bearer ${apiKey}` }),
      ),
  };
}

/**
 * A finite number, or undefined for anything else (null = unlimited stays undefined).
 *
 * @param value the raw value
 * @returns the number or undefined
 */
function numberOrUndefined(value: unknown): number | undefined {
  const num = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(num) ? num : undefined;
}

/**
 * Round to two decimals.
 *
 * @param value the value
 * @returns the rounded value
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

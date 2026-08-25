import { getJson, type JsonFetch } from "../http";
import type { UsageProvider, UsageSnapshot } from "../provider";
import { isToday, monthStartIso, projectMonth } from "./report-utils";

/**
 * Anthropic organization Usage + Cost reports (official Admin API; needs an
 * organization ADMIN key). Source-verified against dbpecka/hacs-claude-stats:
 * `GET /v1/organizations/usage_report/messages` and `/v1/organizations/cost_report`
 * with `x-api-key` + `anthropic-version: 2023-06-01`, params starting_at/ending_at
 * (ISO) + bucket_width=1d, pagination via has_more/next_page (param `page`).
 * Usage results carry `uncached_input_tokens`/`output_tokens`; cost results carry
 * `amount` as a decimal STRING (USD).
 */
const BASE = "https://api.anthropic.com/v1/organizations";

/**
 * Fetch all pages of a bucketed report.
 *
 * @param url the report URL without the page parameter
 * @param headers request headers
 * @param fetchJson the JSON-GET seam
 * @returns all bucket entries
 */
async function fetchAllPages(url: string, headers: Record<string, string>, fetchJson: JsonFetch): Promise<unknown[]> {
  const buckets: unknown[] = [];
  let page: string | undefined;
  for (let i = 0; i < 12; i++) {
    const body = (await fetchJson(page ? `${url}&page=${encodeURIComponent(page)}` : url, headers)) as {
      data?: unknown;
      has_more?: unknown;
      next_page?: unknown;
    } | null;
    if (Array.isArray(body?.data)) {
      buckets.push(...body.data);
    }
    if (body?.has_more !== true || typeof body?.next_page !== "string" || !body.next_page) {
      break;
    }
    page = body.next_page;
  }
  return buckets;
}

/**
 * Parse the two bucket lists into a snapshot: month/today costs (+ projection) and
 * today's input/output tokens.
 *
 * @param usageBuckets the usage report buckets
 * @param costBuckets the cost report buckets
 * @param nowMs current time (ms)
 * @returns the snapshot
 */
export function parseAnthropicReports(usageBuckets: unknown[], costBuckets: unknown[], nowMs: number): UsageSnapshot {
  let costMonth = 0;
  let costToday = 0;
  for (const bucket of costBuckets) {
    const entry = bucket as { starting_at?: unknown; start_time?: unknown; results?: unknown };
    if (!Array.isArray(entry?.results)) {
      continue;
    }
    let sum = 0;
    for (const result of entry.results) {
      const amount = Number((result as { amount?: unknown })?.amount);
      if (Number.isFinite(amount)) {
        sum += amount;
      }
    }
    costMonth += sum;
    if (isToday(entry.starting_at ?? entry.start_time, nowMs)) {
      costToday += sum;
    }
  }

  let inputToday = 0;
  let outputToday = 0;
  let sawUsageToday = false;
  for (const bucket of usageBuckets) {
    const entry = bucket as { starting_at?: unknown; start_time?: unknown; results?: unknown };
    if (!Array.isArray(entry?.results) || !isToday(entry.starting_at ?? entry.start_time, nowMs)) {
      continue;
    }
    sawUsageToday = true;
    for (const result of entry.results) {
      const data = result as { uncached_input_tokens?: unknown; output_tokens?: unknown };
      const input = Number(data.uncached_input_tokens);
      const output = Number(data.output_tokens);
      if (Number.isFinite(input)) {
        inputToday += input;
      }
      if (Number.isFinite(output)) {
        outputToday += output;
      }
    }
  }

  const round = (value: number): number => Math.round(value * 100) / 100;
  const snapshot: UsageSnapshot = {
    costs: {
      today: round(costToday),
      month: round(costMonth),
      projectedMonth: projectMonth(costMonth, nowMs),
      currency: "USD",
    },
  };
  if (sawUsageToday) {
    snapshot.tokens = { inputToday, outputToday };
  }
  return snapshot;
}

/**
 * The Anthropic API provider (organization accounts).
 *
 * @param adminKey the organization ADMIN key
 * @param fetchJson the JSON-GET seam
 * @param now clock (ms) — injected for tests
 * @returns the provider
 */
export function anthropicApiProvider(
  adminKey: string,
  fetchJson: JsonFetch = getJson,
  now: () => number = Date.now,
): UsageProvider {
  return {
    kind: "anthropic-api",
    fetch: async (): Promise<UsageSnapshot> => {
      const headers = { "x-api-key": adminKey, "anthropic-version": "2023-06-01" };
      const start = encodeURIComponent(monthStartIso(now()));
      const usage = await fetchAllPages(
        `${BASE}/usage_report/messages?starting_at=${start}&bucket_width=1d`,
        headers,
        fetchJson,
      );
      const costs = await fetchAllPages(`${BASE}/cost_report?starting_at=${start}&bucket_width=1d`, headers, fetchJson);
      return parseAnthropicReports(usage, costs, now());
    },
  };
}

import { getJson, type JsonFetch } from "../http";
import type { UsageProvider, UsageSnapshot } from "../provider";
import { round2 } from "../pure-helpers";
import { fetchAllPages, isToday, monthStartIso, projectMonth } from "./report-utils";

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

  const snapshot: UsageSnapshot = {
    costs: {
      today: round2(costToday),
      month: round2(costMonth),
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
 * @param warn where a partial report is reported to
 * @returns the provider
 */
export function anthropicApiProvider(
  adminKey: string,
  fetchJson: JsonFetch = getJson,
  now: () => number = Date.now,
  warn: (message: string) => void = () => undefined,
): UsageProvider {
  return {
    kind: "anthropic-api",
    fetch: async (): Promise<UsageSnapshot> => {
      const headers = { "x-api-key": adminKey, "anthropic-version": "2023-06-01" };
      const start = encodeURIComponent(monthStartIso(now()));
      const truncated = (report: string): ((pages: number) => void) => {
        return pages =>
          warn(`the ${report} report was still offering more after ${pages} pages — this month's figures are partial`);
      };
      // `limit=31` like the OpenAI calls: without it the server picks the page size,
      // and a small default turns a month into a walk through many pages — the exact
      // situation the page ceiling exists for.
      const usage = await fetchAllPages(
        `${BASE}/usage_report/messages?starting_at=${start}&bucket_width=1d&limit=31`,
        headers,
        fetchJson,
        truncated("usage"),
      );
      const costs = await fetchAllPages(
        `${BASE}/cost_report?starting_at=${start}&bucket_width=1d&limit=31`,
        headers,
        fetchJson,
        truncated("cost"),
      );
      return parseAnthropicReports(usage, costs, now());
    },
  };
}

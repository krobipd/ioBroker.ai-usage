import { getJson, type JsonFetch } from "../http";
import type { UsageProvider, UsageSnapshot } from "../provider";
import { round2 } from "../pure-helpers";
import { fetchAllPages, isToday, monthStartUnix, projectMonth } from "./report-utils";

/**
 * OpenAI organization Usage + Costs API (official; needs an ADMIN key, not a normal
 * API key — platform.openai.com/docs/api-reference/usage). Daily buckets since the
 * start of the month: `data[]` entries with `start_time` (unix) and `results[]`
 * ({ input_tokens, output_tokens, model } for usage; { amount: { value, currency } }
 * for costs). Pagination via `has_more`/`next_page`.
 */
const BASE = "https://api.openai.com/v1/organization";

/**
 * Parse the two bucket lists into a snapshot: month/today costs (+ projection) and
 * today's tokens with the per-model split.
 *
 * @param usageBuckets the usage report buckets
 * @param costBuckets the cost report buckets
 * @param nowMs current time (ms)
 * @returns the snapshot
 */
export function parseOpenAiReports(usageBuckets: unknown[], costBuckets: unknown[], nowMs: number): UsageSnapshot {
  let costMonth = 0;
  let costToday = 0;
  let currency = "USD";
  for (const bucket of costBuckets) {
    const entry = bucket as { start_time?: unknown; results?: unknown };
    if (!Array.isArray(entry?.results)) {
      continue;
    }
    let sum = 0;
    for (const result of entry.results) {
      const amount = (result as { amount?: { value?: unknown; currency?: unknown } })?.amount;
      const value = Number(amount?.value);
      if (Number.isFinite(value)) {
        sum += value;
      }
      if (typeof amount?.currency === "string" && amount.currency) {
        currency = amount.currency.toUpperCase();
      }
    }
    costMonth += sum;
    if (isToday(entry.start_time, nowMs)) {
      costToday += sum;
    }
  }

  let inputToday = 0;
  let outputToday = 0;
  const perModel = new Map<string, { tokens: number }>();
  let sawUsageToday = false;
  for (const bucket of usageBuckets) {
    const entry = bucket as { start_time?: unknown; results?: unknown };
    if (!Array.isArray(entry?.results) || !isToday(entry.start_time, nowMs)) {
      continue;
    }
    sawUsageToday = true;
    for (const result of entry.results) {
      const data = result as { input_tokens?: unknown; output_tokens?: unknown; model?: unknown };
      const input = Number(data.input_tokens);
      const output = Number(data.output_tokens);
      if (Number.isFinite(input)) {
        inputToday += input;
      }
      if (Number.isFinite(output)) {
        outputToday += output;
      }
      if (typeof data.model === "string" && data.model) {
        const tokens = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
        const existing = perModel.get(data.model) ?? { tokens: 0 };
        existing.tokens += tokens;
        perModel.set(data.model, existing);
      }
    }
  }

  const snapshot: UsageSnapshot = {
    costs: {
      today: round2(costToday),
      month: round2(costMonth),
      projectedMonth: projectMonth(costMonth, nowMs),
      currency,
    },
  };
  if (sawUsageToday) {
    snapshot.tokens = {
      inputToday,
      outputToday,
      perModel: [...perModel.entries()].map(([model, data]) => ({ model, tokens: data.tokens })),
    };
  }
  return snapshot;
}

/**
 * The OpenAI API provider.
 *
 * @param adminKey the organization ADMIN key
 * @param fetchJson the JSON-GET seam
 * @param now clock (ms) — injected for tests
 * @param warn where a partial report is reported to
 * @returns the provider
 */
export function openAiProvider(
  adminKey: string,
  fetchJson: JsonFetch = getJson,
  now: () => number = Date.now,
  warn: (message: string) => void = () => undefined,
): UsageProvider {
  return {
    kind: "openai",
    fetch: async (): Promise<UsageSnapshot> => {
      const headers = { Authorization: `Bearer ${adminKey}` };
      const start = monthStartUnix(now());
      // A truncated report means the month sums below are incomplete — that has to
      // reach the user's log, not be swallowed into a wrong number.
      const truncated = (report: string): ((pages: number) => void) => {
        return pages =>
          warn(`the ${report} report was still offering more after ${pages} pages — this month's figures are partial`);
      };
      const usage = await fetchAllPages(
        `${BASE}/usage/completions?start_time=${start}&bucket_width=1d&limit=31&group_by=model`,
        headers,
        fetchJson,
        truncated("usage"),
      );
      const costs = await fetchAllPages(
        `${BASE}/costs?start_time=${start}&limit=31`,
        headers,
        fetchJson,
        truncated("cost"),
      );
      return parseOpenAiReports(usage, costs, now());
    },
  };
}

import { getJson, type JsonFetch } from "../http";
import type { UsageProvider, UsageSnapshot } from "../provider";
import { finiteNumber, round2 } from "../pure-helpers";
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
  let currencySeen = false;
  for (const bucket of costBuckets) {
    const entry = bucket as { start_time?: unknown; results?: unknown };
    if (!Array.isArray(entry?.results)) {
      continue;
    }
    let sum = 0;
    for (const result of entry.results) {
      const amount = (result as { amount?: { value?: unknown; currency?: unknown } })?.amount;
      const code = typeof amount?.currency === "string" && amount.currency ? amount.currency.toUpperCase() : "";
      // The FIRST currency seen owns the sum; a bucket in another one is skipped
      // rather than added to it. Before, the code of the LAST bucket won while the
      // sum had already swallowed every currency — `totals.ts` does the same on the
      // level above, this one was missing it.
      if (code && !currencySeen) {
        currency = code;
        currencySeen = true;
      }
      if (code && code !== currency) {
        continue;
      }
      const value = finiteNumber(amount?.value);
      if (value !== undefined) {
        sum += value;
      }
    }
    costMonth += sum;
    if (isToday(entry.start_time, nowMs)) {
      costToday += sum;
    }
  }

  let inputToday = 0;
  let outputToday = 0;
  // Every model of the MONTH, each with TODAY's count. The report is fetched for
  // the whole month grouped by model anyway, so the list costs nothing extra — and
  // it is what keeps the model channels in place: built from today's buckets only,
  // the whole `models.*` branch fell out of the answer after every UTC midnight
  // until the first request of the new day, and the orphan sweep deleted it.
  const perModel = new Map<string, { tokens: number }>();
  for (const bucket of usageBuckets) {
    const entry = bucket as { start_time?: unknown; results?: unknown };
    if (!Array.isArray(entry?.results)) {
      continue;
    }
    const today = isToday(entry.start_time, nowMs);
    for (const result of entry.results) {
      const data = result as { input_tokens?: unknown; output_tokens?: unknown; model?: unknown };
      const input = finiteNumber(data.input_tokens);
      const output = finiteNumber(data.output_tokens);
      if (today && input !== undefined) {
        inputToday += input;
      }
      if (today && output !== undefined) {
        outputToday += output;
      }
      if (typeof data.model === "string" && data.model) {
        const existing = perModel.get(data.model) ?? { tokens: 0 };
        if (today) {
          existing.tokens += (input ?? 0) + (output ?? 0);
        }
        perModel.set(data.model, existing);
      }
    }
  }

  // Built unconditionally, exactly like `costs` above: a day with nothing used is
  // a zero, not a missing datapoint. Left out, the counters kept yesterday's
  // numbers under a name that says "today", right next to a `costs.today` that had
  // correctly gone back to 0.
  const snapshot: UsageSnapshot = {
    costs: {
      today: round2(costToday),
      month: round2(costMonth),
      projectedMonth: projectMonth(costMonth, nowMs),
      currency,
    },
    tokens: {
      inputToday,
      outputToday,
      perModel: [...perModel.entries()].map(([model, data]) => ({ model, tokens: data.tokens })),
    },
  };
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

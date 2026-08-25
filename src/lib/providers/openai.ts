import { getJson, type JsonFetch } from "../http";
import type { UsageProvider, UsageSnapshot } from "../provider";
import { isToday, monthStartUnix, projectMonth } from "./report-utils";

/**
 * OpenAI organization Usage + Costs API (official; needs an ADMIN key, not a normal
 * API key — platform.openai.com/docs/api-reference/usage). Daily buckets since the
 * start of the month: `data[]` entries with `start_time` (unix) and `results[]`
 * ({ input_tokens, output_tokens, model } for usage; { amount: { value, currency } }
 * for costs). Pagination via `has_more`/`next_page`.
 */
const BASE = "https://api.openai.com/v1/organization";

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
  // The month yields at most 31 daily buckets — the loop is bounded by has_more.
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

  const round = (value: number): number => Math.round(value * 100) / 100;
  const snapshot: UsageSnapshot = {
    costs: {
      today: round(costToday),
      month: round(costMonth),
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
 * @returns the provider
 */
export function openAiProvider(
  adminKey: string,
  fetchJson: JsonFetch = getJson,
  now: () => number = Date.now,
): UsageProvider {
  return {
    kind: "openai",
    fetch: async (): Promise<UsageSnapshot> => {
      const headers = { Authorization: `Bearer ${adminKey}` };
      const start = monthStartUnix(now());
      const usage = await fetchAllPages(
        `${BASE}/usage/completions?start_time=${start}&bucket_width=1d&limit=31&group_by=model`,
        headers,
        fetchJson,
      );
      const costs = await fetchAllPages(`${BASE}/costs?start_time=${start}&limit=31`, headers, fetchJson);
      return parseOpenAiReports(usage, costs, now());
    },
  };
}

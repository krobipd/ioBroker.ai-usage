import { getJson, type JsonFetch } from "../http";
import { FetchError, type UsageProvider, type UsageSnapshot } from "../provider";

/**
 * GitHub Copilot AI-credit usage (official REST endpoint, docs.github.com/rest/billing/usage):
 * `GET /users/{username}/settings/billing/ai_credit/usage` with a personal access
 * token. The report lists this month's usage items with gross (all requests),
 * discount (covered by the plan) and net (billed) quantities/amounts per SKU/model.
 * A monthly snapshot — GitHub exposes no live counter for individual accounts.
 */

/**
 * Parse the AI-credit usage report into a snapshot: request counters as
 * piece-credits (gross = used, discount = covered by the plan) and billed
 * overage as real monthly costs.
 *
 * @param body the response body
 * @returns the snapshot
 */
export function parseCopilotUsage(body: unknown): UsageSnapshot {
  const items = (body as { usageItems?: unknown } | null)?.usageItems;
  if (!Array.isArray(items)) {
    throw new FetchError("network", "unexpected response shape (no usageItems)");
  }
  let gross = 0;
  let discount = 0;
  let netAmount = 0;
  for (const item of items) {
    const data = item as { grossQuantity?: unknown; discountQuantity?: unknown; netAmount?: unknown };
    const grossQuantity = Number(data.grossQuantity);
    const discountQuantity = Number(data.discountQuantity);
    const amount = Number(data.netAmount);
    if (Number.isFinite(grossQuantity)) {
      gross += grossQuantity;
    }
    if (Number.isFinite(discountQuantity)) {
      discount += discountQuantity;
    }
    if (Number.isFinite(amount)) {
      netAmount += amount;
    }
  }
  const round = (value: number): number => Math.round(value * 100) / 100;
  const snapshot: UsageSnapshot = {
    credits: { used: round(gross), granted: round(discount), currency: "requests", pieces: true },
  };
  if (netAmount > 0) {
    snapshot.costs = { month: round(netAmount), currency: "USD" };
  }
  return snapshot;
}

/**
 * The GitHub Copilot provider.
 *
 * @param username the GitHub user name
 * @param token a personal access token allowed to read the user's billing usage
 * @param fetchJson the JSON-GET seam
 * @returns the provider
 */
export function copilotProvider(username: string, token: string, fetchJson: JsonFetch = getJson): UsageProvider {
  return {
    kind: "copilot",
    fetch: async (): Promise<UsageSnapshot> =>
      parseCopilotUsage(
        await fetchJson(
          `https://api.github.com/users/${encodeURIComponent(username)}/settings/billing/ai_credit/usage`,
          {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
          },
        ),
      ),
  };
}

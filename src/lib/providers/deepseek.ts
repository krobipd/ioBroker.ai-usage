import { getJson, type JsonFetch } from "../http";
import { FetchError, type UsageProvider, type UsageSnapshot } from "../provider";

/**
 * Parse a DeepSeek `GET /user/balance` response into a snapshot. Capture-verified
 * shape: `{ is_available, balance_infos: [{ currency, total_balance,
 * granted_balance, topped_up_balance }] }` — the amounts arrive as strings.
 * With several currency entries the first is used (the rest is ignored).
 *
 * @param body the response body
 * @returns the snapshot
 */
export function parseDeepSeekBalance(body: unknown): UsageSnapshot {
  const obj = body as { is_available?: unknown; balance_infos?: unknown } | null;
  if (typeof obj !== "object" || obj === null || !Array.isArray(obj.balance_infos)) {
    throw new FetchError("network", "unexpected response shape (no balance_infos)");
  }
  const first = obj.balance_infos.find(entry => typeof entry === "object" && entry !== null) as
    Record<string, unknown> | undefined;
  const snapshot: UsageSnapshot = {};
  if (typeof obj.is_available === "boolean") {
    snapshot.available = obj.is_available;
  }
  if (first) {
    snapshot.credits = {
      remaining: parseAmount(first.total_balance),
      granted: parseAmount(first.granted_balance),
      toppedUp: parseAmount(first.topped_up_balance),
      currency: typeof first.currency === "string" ? first.currency : "USD",
    };
  }
  return snapshot;
}

/**
 * The DeepSeek provider: reads the account balance.
 *
 * @param apiKey the DeepSeek API key
 * @param fetchJson the JSON-GET seam (tests inject a fake)
 * @returns the provider
 */
export function deepSeekProvider(apiKey: string, fetchJson: JsonFetch = getJson): UsageProvider {
  return {
    kind: "deepseek",
    fetch: async (): Promise<UsageSnapshot> =>
      parseDeepSeekBalance(
        await fetchJson("https://api.deepseek.com/user/balance", {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        }),
      ),
  };
}

/**
 * Parse a string/number amount to a finite number, or undefined.
 *
 * @param value the raw value ("110.00")
 * @returns the number or undefined
 */
function parseAmount(value: unknown): number | undefined {
  const num = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(num) ? num : undefined;
}

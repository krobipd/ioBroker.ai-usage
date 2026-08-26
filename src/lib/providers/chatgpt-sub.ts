import { getJson, type JsonFetch } from "../http";
import {
  FetchError,
  type LimitWindow,
  type TokenSet,
  type TokenStore,
  type UsageProvider,
  type UsageSnapshot,
} from "../provider";
import { CHATGPT_OAUTH, refreshChatgptTokens, type JsonPost } from "./chatgpt-auth";

/** Where the subscription usage lives (the endpoint OpenAI's own Codex client uses). */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * Read one rate-limit window.
 *
 * Both windows may be null when they do not apply to the account, and `reset_at`
 * is in Unix SECONDS — a value that already looks like milliseconds is passed
 * through, so a future format change cannot produce a year-58000 timestamp.
 *
 * @param raw the window object
 * @param name the object id segment
 * @param label the human-readable label
 * @returns the window, or undefined when unusable
 */
function readWindow(raw: unknown, name: string, label: string): LimitWindow | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const entry = raw as Record<string, unknown>;
  const percent = Number(entry.used_percent);
  if (!Number.isFinite(percent)) {
    return undefined;
  }
  const window: LimitWindow = { name, label, percent };
  const resetAt = Number(entry.reset_at);
  if (Number.isFinite(resetAt) && resetAt > 0) {
    const ms = resetAt > 1e12 ? resetAt : resetAt * 1000;
    window.resetAt = new Date(ms).toISOString();
  }
  return window;
}

/**
 * Parse a `/wham/usage` answer into a snapshot.
 *
 * Fields follow OpenAI's own generated models: `plan_type`, `rate_limit` with a
 * 5-hour `primary_window` and a weekly `secondary_window`, plus `credits` whose
 * balance arrives as a string in the schema but as a number in practice.
 *
 * @param body the parsed answer
 * @returns the snapshot
 */
export function parseChatgptUsage(body: unknown): UsageSnapshot {
  if (typeof body !== "object" || body === null) {
    throw new FetchError("network", "unexpected usage response");
  }
  const raw = body as Record<string, unknown>;
  const limits: LimitWindow[] = [];
  const rateLimit = (raw.rate_limit ?? {}) as Record<string, unknown>;
  const session = readWindow(rateLimit.primary_window, "session", "Session (5 h)");
  const week = readWindow(rateLimit.secondary_window, "week", "Week");
  if (session) {
    limits.push(session);
  }
  if (week) {
    limits.push(week);
  }
  for (const extra of Array.isArray(raw.additional_rate_limits) ? raw.additional_rate_limits : []) {
    if (typeof extra !== "object" || extra === null) {
      continue;
    }
    const entry = extra as Record<string, unknown>;
    const label = typeof entry.limit_name === "string" ? entry.limit_name : "";
    // The name becomes an object-id segment, so it must survive sanitizing and must
    // not collide with a window already collected — a name of "Session" would
    // otherwise overwrite the 5-hour window with an unrelated counter.
    const name = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!name || limits.some(window => window.name === name)) {
      continue;
    }
    const window = readWindow(entry.rate_limit, name, label);
    if (window) {
      // These sit next to the plan-wide session/week windows and cover one model
      // each — reported, but never the reason for a warning (LimitWindow.scoped).
      window.scoped = true;
      limits.push(window);
    }
  }

  const snapshot: UsageSnapshot = {};
  if (limits.length) {
    snapshot.limits = limits;
  }

  const credits = (raw.credits ?? {}) as Record<string, unknown>;
  const balance = Number(credits.balance);
  if (Number.isFinite(balance) && credits.unlimited !== true) {
    snapshot.credits = { remaining: balance, currency: "USD" };
  }
  return snapshot;
}

/**
 * The ChatGPT/Codex subscription provider.
 *
 * @param store where the tokens live (keyed by provider, shared by no one else)
 * @param fetchJson the JSON-GET seam
 * @param postJson the JSON-POST seam (token refresh)
 * @param now clock (ms)
 * @returns the provider
 */
export function chatgptSubProvider(
  store: TokenStore,
  fetchJson: JsonFetch = getJson,
  postJson: JsonPost,
  now: () => number = Date.now,
): UsageProvider {
  let cached: TokenSet | null = null;
  return {
    kind: "chatgpt-sub",
    fetch: async (): Promise<UsageSnapshot> => {
      cached ??= await store.load();
      if (!cached) {
        throw new FetchError("auth", "not signed in — start the ChatGPT sign-in in the instance settings");
      }
      if (now() >= cached.expiresAt - 60_000) {
        cached = await refreshChatgptTokens(cached, postJson, now());
        await store.save(cached);
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${cached.accessToken}`,
        "User-Agent": "ioBroker.ai-usage",
      };
      // Only send the account id when we have one — an empty header is rejected.
      if (cached.accountRef) {
        headers["ChatGPT-Account-Id"] = cached.accountRef;
      }
      return parseChatgptUsage(await fetchJson(CHATGPT_USAGE_URL, headers));
    },
  };
}

export { CHATGPT_OAUTH };

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
 * The reset-voucher inventory ("rate limit reset credits" — purchasable vouchers
 * that clear a full limit window). Shape source-verified against CodexBar
 * (steipete/CodexBar, fetcher + test fixtures): `{ credits: [{ id, reset_type,
 * status, granted_at, expires_at }], available_count }`; the two extra headers
 * are what OpenAI's own desktop client sends on this route.
 */
export const CHATGPT_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

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
    // "service": the service answered with something we cannot read — that is a
    // fault of its own, not a missing connection.
    throw new FetchError("service", "unexpected usage response");
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
 * Read the reset-voucher inventory: how many vouchers are usable right now and
 * when the next one expires.
 *
 * Counted here rather than trusting the server's `available_count`: the answer can
 * carry vouchers whose status still says "available" although their expiry has
 * passed (CodexBar skips those for the same reason). A voucher without an expiry
 * counts as usable. Falls back to the server count when no list is present.
 *
 * @param body the parsed answer
 * @param nowMs current time (ms)
 * @returns voucher count plus the next expiry (empty string while none is held)
 */
export function parseChatgptResetCredits(body: unknown, nowMs: number): { count: number; nextExpiry: string } {
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const list = Array.isArray(raw.credits) ? raw.credits : null;
  if (!list) {
    const serverCount = Number(raw.available_count);
    return { count: Number.isFinite(serverCount) && serverCount >= 0 ? serverCount : 0, nextExpiry: "" };
  }
  let count = 0;
  let nextExpiry = "";
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const voucher = entry as Record<string, unknown>;
    if (voucher.status !== "available") {
      continue;
    }
    const expiresAt = typeof voucher.expires_at === "string" ? voucher.expires_at : "";
    if (expiresAt) {
      const expiryMs = Date.parse(expiresAt);
      if (Number.isFinite(expiryMs) && expiryMs <= nowMs) {
        continue; // stale: still flagged available, but already expired
      }
      if (!nextExpiry || expiresAt < nextExpiry) {
        nextExpiry = expiresAt;
      }
    }
    count++;
  }
  return { count, nextExpiry };
}

/**
 * The ChatGPT/Codex subscription provider.
 *
 * The tokens come from the store on every round and are never held here — see
 * {@link claudeSubProvider} for why that matters when the user signs out.
 *
 * @param store where the tokens live (keyed by provider, shared by no one else)
 * @param postJson the JSON-POST seam (token refresh)
 * @param fetchJson the JSON-GET seam
 * @param now clock (ms)
 * @returns the provider
 */
export function chatgptSubProvider(
  store: TokenStore,
  postJson: JsonPost,
  fetchJson: JsonFetch = getJson,
  now: () => number = Date.now,
): UsageProvider {
  return {
    kind: "chatgpt-sub",
    fetch: async (): Promise<UsageSnapshot> => {
      let tokens: TokenSet | null = await store.load();
      if (!tokens) {
        throw new FetchError("auth", "not signed in — start the ChatGPT sign-in in the instance settings");
      }
      if (now() >= tokens.expiresAt - 60_000) {
        tokens = await refreshChatgptTokens(tokens, postJson, now());
        await store.save(tokens);
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${tokens.accessToken}`,
        "User-Agent": "ioBroker.ai-usage",
      };
      // Only send the account id when we have one — an empty header is rejected.
      if (tokens.accountRef) {
        headers["ChatGPT-Account-Id"] = tokens.accountRef;
      }
      const snapshot = parseChatgptUsage(await fetchJson(CHATGPT_USAGE_URL, headers));
      // Reset-voucher inventory — best-effort second call: its failure must not
      // discard the usage snapshot that already succeeded. The datapoints keep
      // their last value in that case (the orphan sweep no longer touches
      // credit values), so a transient miss never makes them come and go.
      try {
        const vouchers = parseChatgptResetCredits(
          await fetchJson(CHATGPT_RESET_CREDITS_URL, {
            ...headers,
            // What OpenAI's own desktop client sends on this route (CodexBar-verified).
            "OpenAI-Beta": "codex-1",
            originator: "Codex Desktop",
          }),
          now(),
        );
        const credits = snapshot.credits ?? { currency: "USD" };
        credits.resetCredits = vouchers.count;
        credits.resetCreditsNextExpiry = vouchers.nextExpiry;
        snapshot.credits = credits;
      } catch {
        // inventory unavailable this round — the usage snapshot stands on its own
      }
      return snapshot;
    },
  };
}

export { CHATGPT_OAUTH };

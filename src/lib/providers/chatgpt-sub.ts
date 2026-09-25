import { getJson, type JsonFetch, type JsonPost } from "../http";
import { withAuthRetry } from "./auth-retry";
import {
  FetchError,
  type LimitWindow,
  type TokenSet,
  type TokenStore,
  type UsageProvider,
  type UsageSnapshot,
} from "../provider";
import { finiteNumber, sanitizeId } from "../pure-helpers";
import { CHATGPT_IDENTITY, refreshChatgptTokens } from "./chatgpt-auth";

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
 * @param label the English label for log lines
 * @param labelKey i18n key for the translated object name
 * @param labelArg the provider-named part substituted into that key, where there is one
 * @param lockedReason why the provider closed this window, where it says so
 * @returns the window, or undefined when unusable
 */
function readWindow(
  raw: unknown,
  name: string,
  label: string,
  labelKey: string,
  labelArg?: string,
  lockedReason?: string,
): LimitWindow | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const entry = raw as Record<string, unknown>;
  // `finiteNumber`, not `Number`: a window the account does not have arrives as
  // null, and `Number(null)` is 0 — reported as "nothing used yet".
  const percent = finiteNumber(entry.used_percent);
  if (percent === undefined) {
    return undefined;
  }
  const window: LimitWindow = { name, label, percent, labelKey };
  if (labelArg !== undefined) {
    window.labelArg = labelArg;
  }
  const resetAt = finiteNumber(entry.reset_at) ?? 0;
  if (resetAt > 0) {
    const ms = resetAt > 1e12 ? resetAt : resetAt * 1000;
    window.resetAt = new Date(ms).toISOString();
  }
  if (lockedReason) {
    window.lockedReason = lockedReason;
  }
  return window;
}

/**
 * Why the provider stopped this status block, or undefined while it lets work go on.
 *
 * The ChatGPT answer says it outright, next to the percentages (openai/codex,
 * `RateLimitStatusDetails`: `allowed`, `limit_reached`; the payload's
 * `rate_limit_reached_type`; `SpendControlStatusDetails.reached`): a workspace whose
 * credits are used up, or whose spend control stopped it, is locked at any
 * percentage. That is the counterpart of Claude's `locked_reason` (decision 36) —
 * read here, it feeds `limitReached` exactly the same way (decision 90).
 *
 * @param status the `rate_limit` block (of the plan or of one additional limit)
 * @param reachedType the payload's `rate_limit_reached_type`, where it applies
 * @param spendReached whether the workspace's spend control stopped the account
 * @returns the reason, or undefined
 */
function lockOf(status: unknown, reachedType?: unknown, spendReached = false): string | undefined {
  const block = (typeof status === "object" && status !== null ? status : {}) as Record<string, unknown>;
  if (typeof reachedType === "string" && reachedType) {
    return reachedType.replace(/_/g, " ");
  }
  if (spendReached) {
    return "spend control limit reached";
  }
  if (block.limit_reached === true || block.allowed === false) {
    return "usage limit reached";
  }
  return undefined;
}

/** The top-level keys a `/wham/usage` answer is recognised by — presence, not value. */
const CHATGPT_USAGE_KEYS = ["rate_limit", "credits", "additional_rate_limits"] as const;

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
  // Same drift guard as the Claude parser, on the KEYS: an account with nothing
  // used yet still sends `rate_limit` with null windows, so presence is the test,
  // not the parsed result. A body carrying none of them is a shape that moved —
  // reported as a healthy but empty account it would silently clear the alarms
  // and let the orphan sweep take the limit tree.
  if (!CHATGPT_USAGE_KEYS.some(key => key in raw)) {
    throw new FetchError("service", "the usage response carries none of the known fields");
  }
  const limits: LimitWindow[] = [];
  const rateLimit = (raw.rate_limit ?? {}) as Record<string, unknown>;
  const spend = (raw.spend_control ?? {}) as Record<string, unknown>;
  const planLock = lockOf(rateLimit, raw.rate_limit_reached_type, spend.reached === true);
  const session = readWindow(
    rateLimit.primary_window,
    "session",
    "Session (5 h)",
    "nameWindowSession",
    undefined,
    planLock,
  );
  const week = readWindow(rateLimit.secondary_window, "week", "Week", "nameWindowWeekShort", undefined, planLock);
  if (session) {
    limits.push(session);
  }
  if (week) {
    limits.push(week);
  }
  // One entry per metered feature (a model like GPT-5.3-Codex-Spark), and each entry
  // is a STATUS BLOCK of its own — `{ allowed, limit_reached, primary_window,
  // secondary_window }` (openai/codex `AdditionalRateLimitDetails.rate_limit:
  // RateLimitStatusDetails`), not a window. Read as a window, `used_percent` was
  // looked for one level too high and every entry vanished (decision 91).
  for (const extra of Array.isArray(raw.additional_rate_limits) ? raw.additional_rate_limits : []) {
    if (typeof extra !== "object" || extra === null) {
      continue;
    }
    const entry = extra as Record<string, unknown>;
    const label = typeof entry.limit_name === "string" ? entry.limit_name : "";
    const feature = typeof entry.metered_feature === "string" ? entry.metered_feature : "";
    // The metered feature is the stable key; the display name may be reworded. It
    // becomes an object-id segment, through the adapter's ONE id rule.
    const base = sanitizeId(feature || label);
    if (!base) {
      continue;
    }
    const status = entry.rate_limit;
    const block = (typeof status === "object" && status !== null ? status : {}) as Record<string, unknown>;
    const lock = lockOf(status);
    const shown = label || feature;
    for (const [suffix, raw5, key, english] of [
      ["session", block.primary_window, "nameWindowModelSession", `Session (${shown})`],
      ["week", block.secondary_window, "nameWindowModelWeek", `Week (${shown})`],
    ] as const) {
      const name = `${base}-${suffix}`;
      // Case-insensitive: ioBroker ids are case-sensitive, so two spellings of one
      // name would both be created — two nodes for one thing.
      if (limits.some(window => window.name.toLowerCase() === name.toLowerCase())) {
        continue;
      }
      const window = readWindow(raw5, name, english, key, shown, lock);
      if (window) {
        // These sit next to the plan-wide session/week windows and cover one model
        // each — reported, but never the reason for a warning (LimitWindow.scoped).
        window.scoped = true;
        limits.push(window);
      }
    }
  }

  const snapshot: UsageSnapshot = {};
  if (limits.length) {
    snapshot.limits = limits;
  }

  const credits = (raw.credits ?? {}) as Record<string, unknown>;
  const balance = finiteNumber(credits.balance);
  if (balance !== undefined && credits.unlimited !== true) {
    // Codex credits are a unit of their own, not dollars: OpenAI meters them per
    // token on a rate card, and the usage-credit balance is kept apart from the
    // ChatGPT wallet (decision 92). Pieces, so they never enter a money sum.
    snapshot.credits = { remaining: balance, currency: "credits", pieces: true };
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
    const serverCount = finiteNumber(raw.available_count) ?? -1;
    return { count: serverCount >= 0 ? serverCount : 0, nextExpiry: "" };
  }
  let count = 0;
  let nextExpiry = "";
  let nextExpiryMs = Number.POSITIVE_INFINITY;
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
      // Compared as a POINT IN TIME, not as text. Sorting the strings works only
      // while every stamp has the same shape and zone; one with an offset
      // ("+02:00") sorts by its digits and names the wrong next expiry. The
      // millisecond value is right there from the staleness check above.
      if (!nextExpiry || (Number.isFinite(expiryMs) && expiryMs < nextExpiryMs)) {
        nextExpiry = expiresAt;
        nextExpiryMs = expiryMs;
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
 * @param intervalSec the adapter's poll interval — sets how often the voucher
 *   inventory is asked for (roughly hourly, whatever the user configured)
 * @returns the provider
 */
export function chatgptSubProvider(
  store: TokenStore,
  postJson: JsonPost,
  fetchJson: JsonFetch = getJson,
  now: () => number = Date.now,
  intervalSec = 300,
): UsageProvider {
  // Counts down to the next voucher fetch; 0 means "ask on this round", so the
  // first round of a process always does.
  let sinceVouchers = 0;
  return {
    kind: "chatgpt-sub",
    fetch: async (): Promise<UsageSnapshot> => {
      let tokens: TokenSet | null = await store.load();
      if (!tokens) {
        throw new FetchError("no-credentials", "Not signed in — start the ChatGPT sign-in in the instance settings");
      }
      if (now() >= tokens.expiresAt - 60_000) {
        const previous = tokens;
        tokens = await refreshChatgptTokens(tokens, postJson, now());
        await store.replace(previous, tokens);
      }
      const usageHeaders = (current: TokenSet): Record<string, string> => {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${current.accessToken}`,
          // The Codex identity, NOT our own name — see CHATGPT_IDENTITY: the backend
          // gates these routes on the originator, and the second call below already
          // announced itself as a Codex client while this one did not.
          "User-Agent": CHATGPT_IDENTITY.userAgent,
          originator: CHATGPT_IDENTITY.originator,
        };
        // Only send the account id when we have one — an empty header is rejected.
        if (current.accountRef) {
          headers["ChatGPT-Account-Id"] = current.accountRef;
        }
        return headers;
      };
      const snapshot = parseChatgptUsage(
        await withAuthRetry(
          tokens,
          store,
          current => refreshChatgptTokens(current, postJson, now()),
          current => fetchJson(CHATGPT_USAGE_URL, usageHeaders(current)),
        ),
      );
      // Reset-voucher inventory — best-effort second call: its failure must not
      // discard the usage snapshot that already succeeded. The datapoints keep
      // their last value in that case (the orphan sweep no longer touches
      // credit values), so a transient miss never makes them come and go.
      //
      // Not every cycle. Vouchers are bought and redeemed by hand, so the answer is
      // near-static, while `/wham/usage` is IP-throttled and this call goes into the
      // same bucket on the same host — it doubled the requests of every ChatGPT
      // account for a value that barely moves. Fetched on the first round of the
      // process and then once an hour, derived from the poll interval so a faster
      // or slower setting does not change the cadence.
      const voucherEvery = Math.max(1, Math.round(3600 / Math.max(1, intervalSec)));
      const due = sinceVouchers <= 0;
      sinceVouchers = due ? voucherEvery - 1 : sinceVouchers - 1;
      if (!due) {
        return snapshot;
      }
      try {
        const vouchers = parseChatgptResetCredits(
          await fetchJson(CHATGPT_RESET_CREDITS_URL, {
            // From the STORE, not from the local variable: the usage call above may
            // have rotated the tokens on a rejected access token, and the store is
            // the single place that knows which pair is current (decision 16).
            ...usageHeaders((await store.load()) ?? tokens),
            // Route-specific extra on top of the shared identity (CodexBar-verified).
            "OpenAI-Beta": "codex-1",
          }),
          now(),
        );
        const credits = snapshot.credits ?? { currency: "credits", pieces: true };
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

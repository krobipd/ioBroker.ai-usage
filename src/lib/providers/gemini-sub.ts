import { errorText } from "../error-text";
import { withAuthRetry } from "./auth-retry";
import {
  FetchError,
  type LimitWindow,
  type TokenSet,
  type TokenStore,
  type UsageProvider,
  type UsageSnapshot,
} from "../provider";
import type { FormPost, JsonPost } from "../http";
import { refreshGeminiTokens } from "./gemini-auth";
import { finiteNumber, sanitizeId } from "../pure-helpers";

/**
 * Google's internal Code-Assist endpoints. The `daily-` host is tried first:
 * two independent measurements report 429 on the plain host and 200 on `daily-`,
 * so the plain one stays as a fallback rather than as the default.
 */
export const GEMINI_HOSTS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal",
  "https://cloudcode-pa.googleapis.com/v1internal",
] as const;

/**
 * The identity that decides WHICH quota buckets Google returns. Sending the
 * Gemini-CLI identity to a paid account yields the retired free-tier set, where
 * every bucket sits at 100 % forever — a counter that never moves is worse than
 * an error, so both calls must carry this one identity.
 */
export const GEMINI_IDENTITY = {
  ideType: "ANTIGRAVITY",
  userAgent: "antigravity/1.11.3",
} as const;

/**
 * Call a Code-Assist method, falling back to the second host on failure.
 *
 * @param method the method name (loadCodeAssist, retrieveUserQuota)
 * @param body the request body
 * @param accessToken the bearer token
 * @param post the POST seam
 * @returns the parsed answer
 */
async function callCodeAssist(
  method: string,
  body: Record<string, unknown>,
  accessToken: string,
  post: JsonPost,
): Promise<unknown> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": GEMINI_IDENTITY.userAgent,
  };
  let lastError: unknown;
  for (const host of GEMINI_HOSTS) {
    try {
      return await post(`${host}:${method}`, body, { headers });
    } catch (e) {
      // An auth failure is the same on every host — only retry transport trouble.
      if (e instanceof FetchError && e.kind === "auth") {
        throw e;
      }
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new FetchError("network", "no Code-Assist host answered");
}

/** What `loadCodeAssist` says about the account (gemini-cli `LoadCodeAssistResponse`). */
export interface CodeAssistInfo {
  /** The Code-Assist project id, or "" when Google assigned none. */
  project: string;
  /** The tier's readable name. */
  tier: string;
  /** Whether Google reports a current tier at all — without one the account was never set up. */
  hasCurrentTier: boolean;
  /** Why Google considers the account ineligible, where it says so. */
  ineligible: { reasonCode: string; reasonMessage: string; validationUrl: string }[];
}

/**
 * Read the project id, the tier and the reasons for ineligibility out of a
 * `loadCodeAssist` answer.
 *
 * @param body the parsed answer
 * @returns what the answer says about the account
 */
export function parseCodeAssist(body: unknown): CodeAssistInfo {
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const project = typeof raw.cloudaicompanionProject === "string" ? raw.cloudaicompanionProject : "";
  const paid = (raw.paidTier ?? {}) as Record<string, unknown>;
  const current = (raw.currentTier ?? {}) as Record<string, unknown>;
  const tier =
    (typeof paid.name === "string" && paid.name) ||
    (typeof current.name === "string" && current.name) ||
    (typeof paid.id === "string" && paid.id) ||
    (typeof current.id === "string" && current.id) ||
    "";
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const ineligible = (Array.isArray(raw.ineligibleTiers) ? raw.ineligibleTiers : [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map(entry => ({
      reasonCode: text(entry.reasonCode),
      reasonMessage: text(entry.reasonMessage),
      validationUrl: text(entry.validationUrl),
    }));
  const hasCurrentTier = typeof raw.currentTier === "object" && raw.currentTier !== null;
  return { project, tier, hasCurrentTier, ineligible };
}

/**
 * Why an account has no Code-Assist project, in the terms Google gives.
 *
 * gemini-cli (`setup.ts`) tells apart what "no project" can mean: a verification
 * Google asks for (`VALIDATION_REQUIRED` with its link), an account Google calls
 * ineligible (with its own reason), and an account that was never set up (no
 * current tier). Every one of them used to read "a subscription is required" — also
 * to a paying Pro user who had simply never opened Antigravity (decision 99). The
 * adapter never writes to Google, so it cannot do the set-up itself; it names it.
 *
 * @param info what `loadCodeAssist` said
 * @returns the reason, for `info.error`
 */
export function noProjectReason(info: CodeAssistInfo): string {
  const validation = info.ineligible.find(entry => entry.reasonCode === "VALIDATION_REQUIRED" && entry.validationUrl);
  if (validation) {
    return `Google asks for a one-time account verification — ${validation.validationUrl}`;
  }
  const stated = info.ineligible.find(entry => entry.reasonMessage || entry.reasonCode);
  if (stated) {
    return `Google does not offer Code Assist to this account — ${stated.reasonMessage || stated.reasonCode}`;
  }
  if (!info.hasCurrentTier) {
    return "The Google account is not set up for Code Assist yet — open Antigravity once with this account";
  }
  return "Google returned no project for this account — a Google AI subscription (Pro/Ultra) is required";
}

/**
 * Turn a `retrieveUserQuota` answer into limit windows.
 *
 * Google reports what is LEFT (`remainingFraction` 0…1); the tree shows utilisation,
 * so it is inverted here. A bucket without a usable fraction is skipped rather than
 * guessed — an invented 0 % would read as "nothing used yet".
 *
 * @param body the parsed answer
 * @returns the snapshot
 */
export function parseGeminiQuota(body: unknown): UsageSnapshot {
  if (typeof body !== "object" || body === null) {
    // "service": the endpoint answered with an unreadable body — its own fault,
    // not a connection problem (which only a thrown fetch means).
    throw new FetchError("service", "unexpected quota response");
  }
  const raw = body as Record<string, unknown>;
  const buckets = Array.isArray(raw.buckets) ? raw.buckets : [];
  // By name: the same model may come twice (a 5-hour and a weekly bucket, measured
  // by Antigravity-Manager 2026-09-19). The FULLER one stands for the model — the
  // first one used to win, and a 5-hour bucket at 10 % hid a week at 100 % (decision
  // 100, CodexBar `parseQuotaBuckets` keeps the smallest remaining fraction as well).
  const byName = new Map<string, LimitWindow>();
  for (const entry of buckets) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const bucket = entry as Record<string, unknown>;
    // `finiteNumber`, not `Number`: `Number(null)` is 0, and a null remaining
    // fraction would have been reported as a bucket that is 100 % used.
    const fraction = finiteNumber(bucket.remainingFraction);
    if (fraction === undefined) {
      continue;
    }
    const model = typeof bucket.modelId === "string" ? bucket.modelId : "";
    const kind = typeof bucket.tokenType === "string" ? bucket.tokenType.toLowerCase() : "";
    const name = sanitizeId(model || kind || "quota");
    if (!name) {
      continue;
    }
    // NOT `scoped`: Google reports no plan-wide window, so these buckets ARE the plan
    // (`LimitWindow.scoped`, decision 80). The fullest of them speaks for the account
    // and the label names the model, so the warning says which one it came from.
    const window: LimitWindow = {
      name,
      label: model || kind || "Quota",
      // Google names every bucket after a model — the model is the foreign part,
      // the frame around it is translated.
      labelKey: "nameWindowQuota",
      labelArg: model || kind || "",
      percent: Math.round((1 - Math.min(Math.max(fraction, 0), 1)) * 1000) / 10,
    };
    if (typeof bucket.resetTime === "string" && bucket.resetTime) {
      window.resetAt = bucket.resetTime;
    }
    const known = byName.get(name);
    if (!known || window.percent > known.percent) {
      byName.set(name, window);
    }
  }
  const limits = [...byName.values()];
  return limits.length ? { limits } : {};
}

/**
 * Turn a `retrieveUserQuotaSummary` answer into plan-wide pool windows.
 *
 * Antigravity 2.x groups its quota into pools with a 5-hour and a weekly window each
 * ("Gemini Models", "Claude and GPT models"). Shape as lbjlaq/Antigravity-Manager
 * reads it (quota.rs, 2026-09-20): `groups[].{displayName, buckets[].{bucketId,
 * window, remainingFraction, resetTime, displayName}}`. These windows ARE the plan:
 * where they exist, a model bucket is only part of it (decision 101).
 *
 * @param body the parsed answer
 * @returns the pool windows, possibly none
 */
export function parseGeminiPools(body: unknown): LimitWindow[] {
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const pools: LimitWindow[] = [];
  const seen = new Set<string>();
  for (const group of Array.isArray(raw.groups) ? raw.groups : []) {
    if (typeof group !== "object" || group === null) {
      continue;
    }
    const entry = group as Record<string, unknown>;
    const groupName = typeof entry.displayName === "string" ? entry.displayName : "";
    for (const bucket of Array.isArray(entry.buckets) ? entry.buckets : []) {
      if (typeof bucket !== "object" || bucket === null) {
        continue;
      }
      const data = bucket as Record<string, unknown>;
      const fraction = finiteNumber(data.remainingFraction);
      if (fraction === undefined) {
        continue;
      }
      const part =
        (typeof data.displayName === "string" && data.displayName) ||
        (typeof data.window === "string" && data.window) ||
        (typeof data.bucketId === "string" && data.bucketId) ||
        "";
      const key =
        (typeof data.bucketId === "string" && data.bucketId) ||
        (typeof data.window === "string" && data.window) ||
        part;
      const name = sanitizeId(`pool-${groupName || "quota"}-${key || "window"}`);
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const label = [groupName, part].filter(Boolean).join(" ") || "Quota pool";
      const window: LimitWindow = {
        name,
        label,
        labelKey: "nameWindowPool",
        labelArg: label,
        percent: Math.round((1 - Math.min(Math.max(fraction, 0), 1)) * 1000) / 10,
      };
      if (typeof data.resetTime === "string" && data.resetTime) {
        window.resetAt = data.resetTime;
      }
      pools.push(window);
    }
  }
  return pools;
}

/**
 * The Google/Gemini subscription provider.
 *
 * @param store where the tokens live
 * @param post the JSON POST seam
 * @param postForm the form POST seam (token refresh)
 * @param now clock (ms)
 * @param intervalSec the adapter's poll interval — sets how often the pool summary
 *   is asked for (at most every 15 minutes, whatever the user configured)
 * @returns the provider
 */
export function geminiSubProvider(
  store: TokenStore,
  post: JsonPost,
  postForm: FormPost,
  now: () => number = Date.now,
  intervalSec = 300,
): UsageProvider {
  // The last pool answer. Kept when the second call fails, like the ChatGPT voucher
  // values: the scoping of the model buckets must not flip between rounds — that
  // would switch which window drives the warning, round by round.
  let pools: LimitWindow[] = [];
  // Counts down to the next pool call; 0 = ask on this round (so the first round of
  // a process does). Every ~15 minutes: Google answers bursts with 429, and a second
  // call per round would double the requests of every Google account (decision 54's
  // reasoning, applied here).
  let sincePools = 0;
  return {
    kind: "gemini-sub",
    fetch: async (): Promise<UsageSnapshot> => {
      let tokens: TokenSet | null = await store.load();
      if (!tokens) {
        throw new FetchError("no-credentials", "Not signed in — start the Google sign-in in the instance settings");
      }
      if (now() >= tokens.expiresAt - 60_000) {
        const previous = tokens;
        tokens = await refreshGeminiTokens(tokens, postForm, now());
        await store.replace(previous, tokens);
      }
      // The project id is stable per account — look it up once, then reuse it. It
      // is stored with the tokens, so the store's cache keeps it for us.
      if (!tokens.accountRef) {
        const info = parseCodeAssist(
          await callCodeAssist(
            "loadCodeAssist",
            { metadata: { ideType: GEMINI_IDENTITY.ideType } },
            tokens.accessToken,
            post,
          ),
        );
        if (!info.project) {
          // NOT `auth`: the sign-in worked, the account simply has no Code-Assist
          // project. Reporting it as a rejected sign-in sent the user through a
          // sign-in that cannot change the answer.
          throw new FetchError("service", noProjectReason(info));
        }
        const previous = tokens;
        tokens = { ...tokens, accountRef: info.project };
        // Same gate: a sign-out during the lookup must not write the file back.
        await store.replace(previous, tokens);
      }
      const snapshot = parseGeminiQuota(
        await withAuthRetry(
          tokens,
          store,
          current => refreshGeminiTokens(current, postForm, now()),
          async current => {
            try {
              return await callCodeAssist(
                "retrieveUserQuota",
                { project: current.accountRef },
                current.accessToken,
                post,
              );
            } catch (e) {
              // A 403 here is Google saying the quota query is not permitted for this
              // account (CodexBar `fetchQuotaBucketsIfPermitted`) — not a dead
              // sign-in. As `auth` it refreshed, got the same 403 and reported
              // "sign-in rejected" with a notification that no new sign-in can answer
              // (decision 102).
              if (e instanceof FetchError && e.kind === "auth" && e.status === 403) {
                throw new FetchError(
                  "service",
                  `Google does not permit the quota query for this account — ${errorText(e)}`,
                  {
                    status: 403,
                  },
                );
              }
              throw e;
            }
          },
        ),
      );
      const poolEvery = Math.max(1, Math.round(900 / Math.max(1, intervalSec)));
      const due = sincePools <= 0;
      sincePools = due ? poolEvery - 1 : sincePools - 1;
      if (due) {
        try {
          const current = (await store.load()) ?? tokens;
          const fresh = parseGeminiPools(
            await callCodeAssist(
              "retrieveUserQuotaSummary",
              { project: current.accountRef },
              current.accessToken,
              post,
            ),
          );
          if (fresh.length > 0) {
            pools = fresh;
          }
        } catch {
          // Best effort: the model buckets stand on their own, the last pools stay.
        }
      }
      if (pools.length === 0) {
        return snapshot;
      }
      // Pools present: they are the plan, the model buckets only a part of it.
      const models = (snapshot.limits ?? []).map(window => ({ ...window, scoped: true }));
      return { ...snapshot, limits: [...pools, ...models] };
    },
  };
}

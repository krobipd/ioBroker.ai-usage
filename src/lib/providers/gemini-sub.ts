import {
  FetchError,
  type LimitWindow,
  type TokenSet,
  type TokenStore,
  type UsageProvider,
  type UsageSnapshot,
} from "../provider";
import type { FormPost } from "./chatgpt-auth";
import { refreshGeminiTokens } from "./gemini-auth";
import { sanitizeId } from "../pure-helpers";

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

/** A JSON POST seam that also reports which host answered. */
export type GeminiPost = (
  url: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
) => Promise<unknown>;

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
  post: GeminiPost,
): Promise<unknown> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": GEMINI_IDENTITY.userAgent,
  };
  let lastError: unknown;
  for (const host of GEMINI_HOSTS) {
    try {
      return await post(`${host}:${method}`, body, headers);
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

/**
 * Read the project id and the tier out of a `loadCodeAssist` answer.
 *
 * @param body the parsed answer
 * @returns project id and tier label
 */
export function parseCodeAssist(body: unknown): { project: string; tier: string } {
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
  return { project, tier };
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
    throw new FetchError("network", "unexpected quota response");
  }
  const raw = body as Record<string, unknown>;
  const buckets = Array.isArray(raw.buckets) ? raw.buckets : [];
  const limits: LimitWindow[] = [];
  const seen = new Set<string>();
  for (const entry of buckets) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const bucket = entry as Record<string, unknown>;
    const fraction = Number(bucket.remainingFraction);
    if (!Number.isFinite(fraction)) {
      continue;
    }
    const model = typeof bucket.modelId === "string" ? bucket.modelId : "";
    const kind = typeof bucket.tokenType === "string" ? bucket.tokenType.toLowerCase() : "";
    const name = sanitizeId(model || kind || "quota");
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    // Marked `scoped` like every other per-model bucket: Google reports NO plan-wide
    // window, so `limitingWindow` falls back to the fullest of these and names the
    // model in the warning. Without the mark, every single model could raise the
    // account's warning — the "Fable at 100 %" case that made the alarm meaningless.
    const window: LimitWindow = {
      name,
      label: model || kind || "Quota",
      percent: Math.round((1 - Math.min(Math.max(fraction, 0), 1)) * 1000) / 10,
      scoped: true,
    };
    if (typeof bucket.resetTime === "string" && bucket.resetTime) {
      window.resetAt = bucket.resetTime;
    }
    limits.push(window);
  }
  return limits.length ? { limits } : {};
}

/**
 * The Google/Gemini subscription provider.
 *
 * @param store where the tokens live
 * @param post the JSON POST seam
 * @param postForm the form POST seam (token refresh)
 * @param now clock (ms)
 * @returns the provider
 */
export function geminiSubProvider(
  store: TokenStore,
  post: GeminiPost,
  postForm: FormPost,
  now: () => number = Date.now,
): UsageProvider {
  return {
    kind: "gemini-sub",
    fetch: async (): Promise<UsageSnapshot> => {
      let tokens: TokenSet | null = await store.load();
      if (!tokens) {
        throw new FetchError("auth", "not signed in — start the Google sign-in in the instance settings");
      }
      if (now() >= tokens.expiresAt - 60_000) {
        tokens = await refreshGeminiTokens(tokens, postForm, now());
        await store.save(tokens);
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
          throw new FetchError(
            "auth",
            "Google returned no project for this account — a Google AI subscription (Pro/Ultra) is required",
          );
        }
        tokens = { ...tokens, accountRef: info.project };
        await store.save(tokens);
      }
      return parseGeminiQuota(
        await callCodeAssist("retrieveUserQuota", { project: tokens.accountRef }, tokens.accessToken, post),
      );
    },
  };
}

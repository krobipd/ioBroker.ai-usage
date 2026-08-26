import { createHash, randomBytes } from "node:crypto";
import { FetchError, type TokenSet } from "../provider";
import type { FormPost } from "./chatgpt-auth";

/**
 * Constants of the Google sign-in that actually works for consumer subscriptions.
 *
 * The Gemini-CLI client is switched off for individuals ("no longer supported for
 * Gemini Code Assist for individuals"), so the Antigravity client is the only one
 * left. Its secret is public in the open source of an installed application — that
 * is normal for this OAuth flow and not a leak.
 *
 * MEASURED 2026-08-26 against Google (with a control probe, so the test proves
 * something): the device-code flow answers `invalid_client` for BOTH clients, and
 * the paste-code page `codeassist.google.com/authcode` is rejected exactly like an
 * unregistered address. Only the loopback redirect is accepted — which is why the
 * user has to copy the address of the browser error page back into the admin.
 */
export const GEMINI_OAUTH = {
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  redirectUri: "http://localhost:51121/oauth-callback",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  fallbackLifetimeMs: 60 * 60_000,
} as const;

/** The one-time secrets of a running sign-in — kept in memory only. */
export interface GeminiPkce {
  /** The secret half, sent only when redeeming the code. */
  verifier: string;
  /** The public half, sent in the sign-in link. */
  challenge: string;
  /** Ties the pasted answer to this attempt (cross-site check). */
  state: string;
}

/**
 * Create the PKCE pair and the state for one sign-in attempt.
 *
 * @returns the pair
 */
export function generateGeminiPkce(): GeminiPkce {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(16).toString("hex"),
  };
}

/**
 * Build the sign-in link the user opens in a browser.
 *
 * @param pkce the attempt's secrets
 * @returns the authorize URL
 */
export function buildGeminiAuthorizeUrl(pkce: GeminiPkce): string {
  const params = new URLSearchParams({
    client_id: GEMINI_OAUTH.clientId,
    redirect_uri: GEMINI_OAUTH.redirectUri,
    response_type: "code",
    scope: GEMINI_OAUTH.scopes.join(" "),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${GEMINI_OAUTH.authorizeUrl}?${params.toString()}`;
}

/**
 * Pull code and state out of whatever the user pasted back.
 *
 * Google redirects to a local address where nothing listens, so the browser shows
 * an error page — the ADDRESS still carries the result. Users paste the whole
 * address; some paste only the code. Both are accepted, but a wrong state is not:
 * that is the cross-site check.
 *
 * @param pasted the pasted address or bare code
 * @param expectedState the state of the running attempt
 * @returns the authorization code
 */
export function extractGeminiCode(pasted: string, expectedState: string): string {
  const trimmed = pasted.trim();
  if (!trimmed) {
    throw new FetchError("auth", "nothing pasted");
  }
  if (!trimmed.includes("?") && !trimmed.includes("&")) {
    return trimmed;
  }
  const query = trimmed.slice(trimmed.indexOf("?") + 1);
  const params = new URLSearchParams(query);
  const error = params.get("error");
  if (error) {
    throw new FetchError("auth", `Google reported "${error}"`);
  }
  const code = params.get("code");
  if (!code) {
    throw new FetchError("auth", "the pasted address carries no code");
  }
  const state = params.get("state");
  if (state && state !== expectedState) {
    throw new FetchError("auth", "the pasted address belongs to a different sign-in attempt");
  }
  return code;
}

/**
 * Redeem the code for tokens.
 *
 * @param code the authorization code
 * @param pkce the attempt's secrets
 * @param post the form POST seam
 * @param now current time in ms
 * @returns the token set
 */
export async function exchangeGeminiCode(
  code: string,
  pkce: GeminiPkce,
  post: FormPost,
  now: number,
): Promise<TokenSet> {
  const body = await post(GEMINI_OAUTH.tokenUrl, {
    grant_type: "authorization_code",
    client_id: GEMINI_OAUTH.clientId,
    client_secret: GEMINI_OAUTH.clientSecret,
    code,
    code_verifier: pkce.verifier,
    redirect_uri: GEMINI_OAUTH.redirectUri,
  });
  return toTokenSet(body, now, "");
}

/**
 * Get a fresh access token; Google often omits a new refresh token, then the old stays.
 *
 * @param tokens the current tokens
 * @param post the form POST seam
 * @param now current time in ms
 * @returns the refreshed token set
 */
export async function refreshGeminiTokens(tokens: TokenSet, post: FormPost, now: number): Promise<TokenSet> {
  const body = await post(GEMINI_OAUTH.tokenUrl, {
    grant_type: "refresh_token",
    client_id: GEMINI_OAUTH.clientId,
    client_secret: GEMINI_OAUTH.clientSecret,
    refresh_token: tokens.refreshToken,
  });
  return toTokenSet(body, now, tokens.refreshToken, tokens.accountRef);
}

/**
 * Build a token set from a Google token answer.
 *
 * @param body the parsed answer
 * @param now current time in ms
 * @param previousRefresh refresh token to keep when the answer omits one
 * @param previousAccount project id to keep
 * @returns the token set
 */
function toTokenSet(body: unknown, now: number, previousRefresh: string, previousAccount?: string): TokenSet {
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const accessToken = typeof raw.access_token === "string" ? raw.access_token : "";
  if (!accessToken) {
    throw new FetchError("auth", "no access token in the answer");
  }
  const lifetime = Number(raw.expires_in);
  return {
    accessToken,
    refreshToken: typeof raw.refresh_token === "string" && raw.refresh_token ? raw.refresh_token : previousRefresh,
    expiresAt: now + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime * 1000 : GEMINI_OAUTH.fallbackLifetimeMs),
    accountRef: previousAccount,
  };
}

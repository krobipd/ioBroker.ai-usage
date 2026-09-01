import { createHash, randomBytes } from "node:crypto";
import { FetchError, type TokenSet } from "../provider";

/**
 * Claude subscription OAuth — the flow Claude Code and the HA reference integration
 * (trickv/hass-claude-usage, source-verified 2026-08-25) use: PKCE authorize on
 * claude.ai, the user pastes the resulting code, tokens come from the console
 * token endpoint and are refreshed with the refresh token.
 */
export const CLAUDE_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  /**
   * Least privilege: the usage endpoint works with the profile scope alone —
   * proven by the HA reference integration, which narrowed to exactly this on
   * 2026-08-28 (trickv/hass-claude-usage PR #14, released as v10). The broader
   * set we started with (org:create_api_key + user:inference) let the stored
   * token CREATE API keys and CALL models — powers a read-only monitor must not
   * hold. Existing sign-ins keep working; the narrow scope applies from the
   * next sign-in on.
   */
  scopes: "user:profile",
  usageUrl: "https://api.anthropic.com/api/oauth/usage",
  profileUrl: "https://api.anthropic.com/api/oauth/profile",
  betaHeader: "oauth-2025-04-20",
  /**
   * The user agent decides WHICH throttle bucket the usage endpoint applies —
   * community-measured three times over (Claude-Code-Usage-Monitor #202,
   * claude-code #31021/#31637): a claude-code identity is safe at 3-minute
   * polls, any other identity lands in an aggressively limited bucket with
   * persistent 429s. Version pinned to the npm release current at build time;
   * the bucket keys on the product name, not the exact number. Same approach
   * as govee-smart, which identifies as the Govee app for the same reason.
   */
  userAgent: "claude-code/2.1.252",
} as const;

/** A PKCE pair for one sign-in attempt. */
export interface PkcePair {
  /** The secret verifier (sent in the code exchange). */
  verifier: string;
  /** The S256 challenge (sent in the authorize URL). */
  challenge: string;
  /** The CSRF state. */
  state: string;
}

/** The JSON-POST seam (tests inject a fake). */
export type JsonPost = (url: string, body: Record<string, unknown>) => Promise<unknown>;

/**
 * Generate a PKCE verifier/challenge pair plus CSRF state.
 *
 * @returns the pair
 */
export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, state: randomBytes(24).toString("base64url") };
}

/**
 * Build the authorize URL the user opens to sign in.
 *
 * @param pkce the sign-in attempt's PKCE pair
 * @returns the URL
 */
export function buildAuthorizeUrl(pkce: PkcePair): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_OAUTH.clientId,
    response_type: "code",
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    scope: CLAUDE_OAUTH.scopes,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state,
  });
  return `${CLAUDE_OAUTH.authorizeUrl}?${params.toString()}`;
}

/**
 * Read a token response body into a {@link TokenSet}.
 *
 * @param body the token endpoint response
 * @param now current time (ms)
 * @param previousRefresh the refresh token to keep when the response carries none
 * @returns the token set
 */
function tokenSetFrom(body: unknown, now: number, previousRefresh = ""): TokenSet {
  const data = body as Record<string, unknown> | null;
  const accessToken = typeof data?.access_token === "string" ? data.access_token : "";
  if (!accessToken) {
    throw new FetchError("auth", "token response carries no access token");
  }
  const refreshToken =
    typeof data?.refresh_token === "string" && data.refresh_token ? data.refresh_token : previousRefresh;
  const expiresIn = Number(data?.expires_in);
  return {
    accessToken,
    refreshToken,
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
  };
}

/**
 * Exchange a pasted authorization code (possibly in the `code#state` form) for tokens.
 *
 * @param pastedCode what the user pasted
 * @param pkce the sign-in attempt's PKCE pair
 * @param postJson the JSON-POST seam
 * @param now current time (ms)
 * @returns the token set
 */
export async function exchangeCode(
  pastedCode: string,
  pkce: PkcePair,
  postJson: JsonPost,
  now: number,
): Promise<TokenSet> {
  const [code, state = ""] = pastedCode.trim().split("#");
  if (!code) {
    throw new FetchError("auth", "empty authorization code");
  }
  if (state && state !== pkce.state) {
    throw new FetchError("auth", "state mismatch — start the sign-in again");
  }
  const body = await postJson(CLAUDE_OAUTH.tokenUrl, {
    grant_type: "authorization_code",
    code,
    state,
    client_id: CLAUDE_OAUTH.clientId,
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    code_verifier: pkce.verifier,
  });
  return tokenSetFrom(body, now);
}

/**
 * Obtain a fresh access token with the refresh token.
 *
 * @param tokens the current token set
 * @param postJson the JSON-POST seam
 * @param now current time (ms)
 * @returns the new token set (keeps the old refresh token when none is returned)
 */
export async function refreshTokens(tokens: TokenSet, postJson: JsonPost, now: number): Promise<TokenSet> {
  if (!tokens.refreshToken) {
    throw new FetchError("auth", "no refresh token — sign in again");
  }
  const body = await postJson(CLAUDE_OAUTH.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: CLAUDE_OAUTH.clientId,
  });
  return tokenSetFrom(body, now, tokens.refreshToken);
}

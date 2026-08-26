import { jwtExpiry, chatgptAccountId } from "../jwt";
import { FetchError, type TokenSet } from "../provider";

/** Constants of the Codex device-code sign-in (openai/codex, login/src/auth/manager.rs). */
export const CHATGPT_OAUTH = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  deviceCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  devicePollUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  tokenUrl: "https://auth.openai.com/oauth/token",
  deviceRedirectUri: "https://auth.openai.com/deviceauth/callback",
  /** Where the user types the code. */
  verificationUrl: "https://auth.openai.com/codex/device",
  /** The code is valid for 15 minutes (prompt text in the CLI). */
  windowMs: 15 * 60_000,
  /** Fallback lifetime when the access token carries no expiry. */
  fallbackLifetimeMs: 60 * 60_000,
} as const;

/** A JSON POST seam (injected so the modules stay testable). */
export type JsonPost = (
  url: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
) => Promise<unknown>;
/** A form POST seam. */
export type FormPost = (
  url: string,
  form: Record<string, string>,
  headers?: Record<string, string>,
) => Promise<unknown>;

/** What the device-code start handed back — the user-facing half plus the polling handle. */
export interface DeviceCodeStart {
  /** The short code the user types on {@link CHATGPT_OAUTH.verificationUrl}. */
  userCode: string;
  /** Opaque handle for the polling calls. */
  deviceAuthId: string;
  /** Seconds between polls, as advised by the server. */
  intervalSec: number;
  /** Absolute end of the sign-in window (ms since epoch). */
  expiresAt: number;
}

/**
 * Read a field out of an untrusted JSON answer.
 *
 * @param body the parsed answer
 * @param key the field name
 * @returns the string value, or ""
 */
function str(body: unknown, key: string): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/**
 * Start the device-code sign-in: ask OpenAI for a user code.
 *
 * @param post the JSON POST seam
 * @param now current time in ms
 * @returns what the admin panel has to show plus the polling handle
 */
export async function startDeviceCode(post: JsonPost, now: number): Promise<DeviceCodeStart> {
  const body = await post(CHATGPT_OAUTH.deviceCodeUrl, { client_id: CHATGPT_OAUTH.clientId });
  const userCode = str(body, "user_code");
  const deviceAuthId = str(body, "device_auth_id");
  if (!userCode || !deviceAuthId) {
    throw new FetchError("network", "unexpected device-code response");
  }
  // The server sends the interval as a STRING; never poll faster than once a second.
  const advised = Number(str(body, "interval"));
  return {
    userCode,
    deviceAuthId,
    intervalSec: Number.isFinite(advised) && advised >= 1 ? advised : 5,
    expiresAt: now + CHATGPT_OAUTH.windowMs,
  };
}

/** One polling result: still waiting, or the authorization code plus its verifier. */
export type DevicePollResult = { status: "pending" } | { status: "ready"; code: string; codeVerifier: string };

/**
 * Ask once whether the user confirmed the code.
 *
 * "Not confirmed yet" arrives as an auth failure (403/404 in the CLI) — that is a
 * WAIT, not an error, so it must not bubble up as a broken sign-in.
 *
 * @param start the handle from {@link startDeviceCode}
 * @param post the JSON POST seam
 * @returns pending or the redeemable code
 */
export async function pollDeviceCode(start: DeviceCodeStart, post: JsonPost): Promise<DevicePollResult> {
  let body: unknown;
  try {
    body = await post(CHATGPT_OAUTH.devicePollUrl, {
      device_auth_id: start.deviceAuthId,
      user_code: start.userCode,
    });
  } catch (e) {
    if (e instanceof FetchError && e.kind === "auth") {
      return { status: "pending" };
    }
    throw e;
  }
  const code = str(body, "authorization_code");
  const codeVerifier = str(body, "code_verifier");
  if (!code || !codeVerifier) {
    return { status: "pending" };
  }
  return { status: "ready", code, codeVerifier };
}

/**
 * Redeem the authorization code for tokens (form-encoded, unlike the refresh call).
 *
 * @param code the authorization code
 * @param codeVerifier the verifier the server handed back
 * @param post the form POST seam
 * @param now current time in ms
 * @returns the token set including the ChatGPT account id
 */
export async function exchangeDeviceCode(
  code: string,
  codeVerifier: string,
  post: FormPost,
  now: number,
): Promise<TokenSet> {
  const body = await post(CHATGPT_OAUTH.tokenUrl, {
    grant_type: "authorization_code",
    client_id: CHATGPT_OAUTH.clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: CHATGPT_OAUTH.deviceRedirectUri,
  });
  return toTokenSet(body, now, "");
}

/**
 * Get a fresh access token. The answer carries no lifetime — it comes out of the
 * token itself — and often no new refresh token, in which case the old one stays.
 *
 * @param tokens the current tokens
 * @param post the JSON POST seam (refresh is JSON, not form-encoded)
 * @param now current time in ms
 * @returns the refreshed token set
 */
export async function refreshChatgptTokens(tokens: TokenSet, post: JsonPost, now: number): Promise<TokenSet> {
  const body = await post(CHATGPT_OAUTH.tokenUrl, {
    client_id: CHATGPT_OAUTH.clientId,
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  });
  return toTokenSet(body, now, tokens.refreshToken, tokens.accountRef);
}

/**
 * Build a token set from a token answer.
 *
 * @param body the parsed answer
 * @param now current time in ms
 * @param previousRefresh refresh token to keep when the answer omits one
 * @param previousAccount account id to keep when no id token came back
 * @returns the token set
 */
function toTokenSet(body: unknown, now: number, previousRefresh: string, previousAccount?: string): TokenSet {
  const accessToken = str(body, "access_token");
  if (!accessToken) {
    throw new FetchError("auth", "no access token in the answer");
  }
  const idToken = str(body, "id_token");
  return {
    accessToken,
    refreshToken: str(body, "refresh_token") || previousRefresh,
    expiresAt: jwtExpiry(accessToken, CHATGPT_OAUTH.fallbackLifetimeMs, now),
    accountRef: (idToken ? chatgptAccountId(idToken) : undefined) ?? previousAccount,
  };
}

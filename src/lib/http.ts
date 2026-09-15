import { FetchError } from "./provider";

/** Per-request timeout (ms). */
const REQUEST_TIMEOUT_MS = 15000;

/** The JSON-GET seam the provider modules use — injectable for tests. */
export type JsonFetch = (url: string, headers: Record<string, string>) => Promise<unknown>;

/**
 * Per-call options of the two POST seams.
 *
 * `authOn400` used to be baked into `postJson`/`postForm`, which made EVERY post
 * read a 400 as a rejected sign-in. That is right for the OAuth token endpoints
 * and wrong everywhere else: the ChatGPT device-code poll takes an auth failure
 * as "the user has not confirmed yet" and would have waited out the whole
 * fifteen minutes on a 400, and Google's Code-Assist call skipped its second
 * host because it thought the sign-in was gone. The flag belongs at the call.
 */
export interface PostOptions {
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** True only for OAuth token endpoints, which answer a dead code or refresh token with 400. */
  authOn400?: boolean;
}

/** The JSON-POST seam — one definition for every provider module. */
export type JsonPost = (url: string, body: Record<string, unknown>, options?: PostOptions) => Promise<unknown>;

/** The form-POST seam (OAuth code redemption). */
export type FormPost = (url: string, form: Record<string, string>, options?: PostOptions) => Promise<unknown>;

/**
 * Run one request and turn its outcome into the shared failure classification:
 * 401/403 (and 400 where the provider answers a rejected grant that way) become an
 * auth error, 429 a rate-limit error, any other bad status or unparsable body a
 * SERVICE error (the service answered and is broken), and only a throw — refused
 * connection, DNS failure, timeout — a network error. The poll engine turns that
 * split into "the AI service is down" versus "this host has no connection".
 *
 * @param url the request URL
 * @param init the request options (method, headers, body)
 * @param authOn400 true when a 400 means a rejected grant rather than a service fault
 * @returns the parsed JSON body
 */
async function request(url: string, init: RequestInit, authOn400 = false): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    throw new FetchError("network", e instanceof Error ? e.message : String(e));
  }
  if (!response.ok) {
    // The status alone reaches the user as `info.error`, and "HTTP 401" tells them
    // nothing they can act on. OpenRouter, OpenAI and Anthropic all answer with
    // `{ error: { message } }` — reading it turns the datapoint into "invalid API
    // key". Best effort in the strictest sense: the status decides the class, the
    // body only decorates the text, and a body that cannot be read changes nothing.
    const detail = await errorDetail(response);
    if (response.status === 401 || response.status === 403 || (authOn400 && response.status === 400)) {
      throw new FetchError("auth", `HTTP ${response.status}${detail}`);
    }
    if (response.status === 429) {
      throw new FetchError("rate-limit", `HTTP 429${detail}`);
    }
    // 5xx = the service answered and is broken; anything else unexpected is treated
    // the same way, because the service DID answer — only a throw above means we
    // never reached it.
    throw new FetchError("service", `HTTP ${response.status}${detail}`);
  }
  try {
    return await response.json();
  } catch (e) {
    throw new FetchError("service", `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Longest provider message taken over into the error text. */
const MAX_DETAIL_CHARS = 200;

/**
 * The provider's own words for a failed request, ready to append.
 *
 * Never throws and never rejects: a body that is missing, unreadable, not JSON or
 * shaped differently simply yields "" and the caller keeps the bare status. The
 * body of a failed response is consumed here either way, so nothing is left
 * dangling (measured 2026-09-12: the "socket leak" this used to be blamed on does
 * not exist).
 *
 * @param response the failed response
 * @returns " — <message>" or an empty string
 */
async function errorDetail(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "";
  }
  let message: unknown;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error = body.error;
    message =
      typeof error === "string" ? error : ((error as { message?: unknown })?.message ?? body.message ?? undefined);
  } catch {
    // Not JSON: a short plain-text body is still better than nothing, a long one
    // (an HTML error page from a proxy) is noise.
    message = text.trim().length > 0 && text.trim().length <= MAX_DETAIL_CHARS ? text.trim() : undefined;
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    return "";
  }
  const trimmed = message.trim();
  return ` — ${trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…` : trimmed}`;
}

/**
 * GET a JSON document.
 *
 * @param url the request URL
 * @param headers request headers (Authorization etc.)
 * @returns the parsed JSON body
 */
export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  return request(url, { headers });
}

/**
 * POST a JSON document.
 *
 * @param url the request URL
 * @param body the JSON body
 * @param options extra headers, and whether a 400 means a rejected grant
 * @returns the parsed JSON response
 */
export async function postJson(
  url: string,
  body: Record<string, unknown>,
  options: PostOptions = {},
): Promise<unknown> {
  return request(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...options.headers },
      body: JSON.stringify(body),
    },
    options.authOn400 === true,
  );
}

/**
 * POST a form-encoded body and return the parsed JSON answer.
 *
 * OAuth code redemption uses form encoding while token refresh often uses JSON —
 * ChatGPT/Codex needs BOTH, so the two shapes are separate helpers rather than one
 * guessing wrapper.
 *
 * @param url the request URL
 * @param form the form fields
 * @param options extra headers, and whether a 400 means a rejected grant
 * @returns the parsed JSON body
 */
export async function postForm(url: string, form: Record<string, string>, options: PostOptions = {}): Promise<unknown> {
  return request(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...options.headers },
      body: new URLSearchParams(form).toString(),
    },
    options.authOn400 === true,
  );
}

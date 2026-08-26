import { FetchError } from "./provider";

/** Per-request timeout (ms). */
const REQUEST_TIMEOUT_MS = 15000;

/** The JSON-GET seam the provider modules use — injectable for tests. */
export type JsonFetch = (url: string, headers: Record<string, string>) => Promise<unknown>;

/**
 * GET a JSON document with the shared failure classification: 401/403 become an
 * auth error, 429 a rate-limit error, any other bad status or unparsable body a
 * SERVICE error (the service answered and is broken), and only a throw — refused
 * connection, DNS failure, timeout — a network error. The poll engine turns that
 * split into "the AI service is down" versus "this host has no connection".
 *
 * @param url the request URL
 * @param headers request headers (Authorization etc.)
 * @returns the parsed JSON body
 */
export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    throw new FetchError("network", e instanceof Error ? e.message : String(e));
  }
  if (response.status === 401 || response.status === 403) {
    throw new FetchError("auth", `HTTP ${response.status}`);
  }
  if (response.status === 429) {
    throw new FetchError("rate-limit", "HTTP 429");
  }
  if (!response.ok) {
    // 5xx = the service answered and is broken; anything else unexpected is treated
    // the same way, because the service DID answer — only a throw above means we
    // never reached it.
    throw new FetchError("service", `HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new FetchError("service", "invalid JSON response");
  }
}

/**
 * POST a JSON document with the same failure classification as {@link getJson}.
 *
 * @param url the request URL
 * @param body the JSON body
 * @returns the parsed JSON response
 */
export async function postJson(url: string, body: Record<string, unknown>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new FetchError("network", e instanceof Error ? e.message : String(e));
  }
  if (response.status === 401 || response.status === 403 || response.status === 400) {
    throw new FetchError("auth", `HTTP ${response.status}`);
  }
  if (response.status === 429) {
    throw new FetchError("rate-limit", "HTTP 429");
  }
  if (!response.ok) {
    // 5xx = the service answered and is broken; anything else unexpected is treated
    // the same way, because the service DID answer — only a throw above means we
    // never reached it.
    throw new FetchError("service", `HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new FetchError("service", "invalid JSON response");
  }
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
 * @param headers extra headers
 * @returns the parsed JSON body
 */
export async function postForm(
  url: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new FetchError("network", e instanceof Error ? e.message : String(e));
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new FetchError("auth", `HTTP ${response.status}`);
  }
  if (response.status === 429) {
    throw new FetchError("rate-limit", "HTTP 429");
  }
  if (!response.ok) {
    // 5xx = the service answered and is broken; anything else unexpected is treated
    // the same way, because the service DID answer — only a throw above means we
    // never reached it.
    throw new FetchError("service", `HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (e) {
    throw new FetchError("service", `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

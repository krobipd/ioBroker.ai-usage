import { FetchError } from "./provider";

/** Per-request timeout (ms). */
const REQUEST_TIMEOUT_MS = 15000;

/** The JSON-GET seam the provider modules use — injectable for tests. */
export type JsonFetch = (url: string, headers: Record<string, string>) => Promise<unknown>;

/**
 * GET a JSON document with the shared failure classification: 401/403 become an
 * auth error, 429 a rate-limit error, everything else (bad status, network throw,
 * timeout, invalid JSON) a network error — the classes the poll engine acts on.
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
    throw new FetchError("network", `HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new FetchError("network", "invalid JSON response");
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
    throw new FetchError("network", `HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new FetchError("network", "invalid JSON response");
  }
}

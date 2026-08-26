/**
 * Read claims out of a JWT we RECEIVED — no signature check.
 *
 * We are the token's holder, not its verifier: the provider validates it on every
 * call. All we need is metadata the token carries because the responses do not:
 * the expiry (ChatGPT's refresh answer has no `expires_in`) and the ChatGPT account
 * id (which lives in a namespaced claim, not in any profile endpoint).
 *
 * @param token the compact JWT
 * @returns the payload as a record, or null when it is not a readable JWT
 */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The absolute expiry of an access token, in ms since epoch.
 *
 * @param token the access token
 * @param fallbackMs how long to assume when the token carries no `exp`
 * @param now current time in ms
 * @returns the expiry timestamp
 */
export function jwtExpiry(token: string, fallbackMs: number, now: number): number {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : now + fallbackMs;
}

/**
 * The ChatGPT account id, carried in a namespaced claim of the id token.
 *
 * @param idToken the id token from the OAuth exchange
 * @returns the account id, or undefined
 */
export function chatgptAccountId(idToken: string): string | undefined {
  const auth = jwtClaims(idToken)?.["https://api.openai.com/auth"];
  if (typeof auth !== "object" || auth === null) {
    return undefined;
  }
  const value = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof value === "string" && value ? value : undefined;
}

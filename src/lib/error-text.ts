/**
 * One readable line for anything a `catch` can hand over.
 *
 * Deliberately without imports: every layer uses it, including `http.ts`, which
 * sits below the helper modules.
 */

/** Longest text a stringified object may contribute before it is cut. */
const MAX_OBJECT_CHARS = 200;

/**
 * An Error's own reason: its message, or its string `code` when the message is empty.
 *
 * `http.get` and `net.connect` to `localhost` reject with an `AggregateError` whose
 * message is `""` and whose reason sits in `code: "ECONNREFUSED"` — the message alone
 * would render as nothing.
 *
 * @param err the error
 * @returns the reason, or "" when the error carries neither
 */
function reasonOf(err: Error): string {
  const message = typeof err.message === "string" ? err.message : "";
  if (message) {
    return message;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

/**
 * Text for a value that is not an Error — the branches every caught value shares.
 *
 * @param err the caught value
 * @returns a single-line description
 */
function valueText(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "function") {
    // `String()` would print the whole source text of a thrown function or class.
    return Object.prototype.toString.call(err);
  }
  if (err === null || err === undefined || typeof err !== "object") {
    // Numbers, booleans, symbols, bigint: `String()` is the readable form.
    return String(err);
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(err);
  } catch {
    // Circular, or a getter that throws — fall through to the tag below.
    json = undefined;
  }
  const text = json ?? Object.prototype.toString.call(err);
  return text.length > MAX_OBJECT_CHARS ? `${text.slice(0, MAX_OBJECT_CHARS)}…` : text;
}

/**
 * Turn any thrown value into text a user can read.
 *
 * JavaScript lets code throw anything, and the inline
 * `e instanceof Error ? e.message : String(e)` this replaces rendered every plain
 * object as `[object Object]` — a rejected `{ code: "ECONNRESET" }` or an HTTP
 * client's error object reached the log and Sentry with nothing in it.
 *
 * An Error contributes its message (its `code` when the message is empty) and, one
 * level deep, the text of its `cause`: Node's `fetch` rejects every network failure
 * as `fetch failed` and keeps the real reason (`getaddrinfo ENOTFOUND host`) only
 * there. The whole body runs inside a `try` — this is called from `catch` blocks,
 * and a getter that throws must not turn the explanation into a second failure.
 *
 * @param err the caught value
 * @returns a single-line description, never empty
 */
export function errorText(err: unknown): string {
  try {
    if (!(err instanceof Error)) {
      return valueText(err);
    }
    const own = reasonOf(err) || err.name || "Error";
    const cause = (err as { cause?: unknown }).cause;
    if (cause === undefined || cause === null) {
      return own;
    }
    const causeText = cause instanceof Error ? reasonOf(cause) : valueText(cause);
    return causeText && !own.includes(causeText) ? `${own} (${causeText})` : own;
  } catch {
    return Object.prototype.toString.call(err);
  }
}

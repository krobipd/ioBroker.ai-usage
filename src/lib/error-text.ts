/**
 * One readable line for anything a `catch` can hand over.
 *
 * Deliberately without imports: every layer uses it, including `http.ts`, which
 * sits below the helper modules.
 */

/** Longest text a stringified object may contribute before it is cut. */
const MAX_OBJECT_CHARS = 200;

/**
 * Turn any thrown value into text a user can read.
 *
 * JavaScript lets code throw anything, and the inline
 * `e instanceof Error ? e.message : String(e)` this replaces rendered every plain
 * object as `[object Object]` — a rejected `{ code: "ECONNRESET" }` or an HTTP
 * client's error object reached the log and Sentry with nothing in it.
 *
 * The object branch is the point of the helper; `String()` already covers strings,
 * numbers and symbols. `JSON.stringify` is guarded twice because it is hostile in
 * exactly the situation this runs in: it THROWS on a circular structure (an error
 * carrying the response it came from) and RETURNS `undefined` for a value it
 * cannot represent at all.
 *
 * @param err the caught value
 * @returns a single-line description, never empty
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    // `message` can be empty on a hand-built error — the name still says something.
    return err.message || err.name || "Error";
  }
  if (typeof err === "string") {
    return err;
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

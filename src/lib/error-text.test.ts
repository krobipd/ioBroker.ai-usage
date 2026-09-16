import { errorText } from "./error-text";

/**
 * What is pinned here is the OBJECT branch.
 *
 * The inline `e instanceof Error ? e.message : String(e)` this helper replaced was
 * right about errors and strings and wrong about everything else: a rejected
 * `{ code: "ECONNRESET" }` reached the log, the `info.error` datapoint and Sentry as
 * the literal text `[object Object]`. Every case below that is not an `Error` is the
 * reason the helper exists.
 */
describe("errorText", () => {
  test("an Error contributes its message", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
  });

  test("an Error without a message falls back to its name, never to an empty line", () => {
    // A hand-built `new Error()` and some library errors carry no message at all.
    // An empty error text is indistinguishable from "everything is fine".
    expect(errorText(new Error())).toBe("Error");
    expect(errorText(new TypeError())).toBe("TypeError");
  });

  test("a thrown string is the message", () => {
    expect(errorText("plain failure")).toBe("plain failure");
  });

  test("a thrown plain object is readable instead of [object Object]", () => {
    // The defect this helper was written for.
    expect(errorText({ code: "ECONNRESET" })).toBe('{"code":"ECONNRESET"}');
  });

  test("a circular object does not throw — the error text may never become the error", () => {
    // An error carrying the response it came from is circular, and `JSON.stringify`
    // THROWS on it. A helper that throws while explaining a failure would replace a
    // logged line with a crash.
    const circular: Record<string, unknown> = { code: "EAI_AGAIN" };
    circular.self = circular;
    expect(errorText(circular)).toBe("[object Object]");
  });

  test("an object JSON refuses to represent still yields a tag", () => {
    // `JSON.stringify` RETURNS undefined here rather than throwing — the second of
    // its two hostile behaviours, and the only reason the `??` is not dead code.
    // A `toJSON` answering undefined is how a real library error does this.
    expect(errorText({ toJSON: () => undefined })).toBe("[object Object]");
  });

  test("an object without a prototype is still serialised, not tagged", () => {
    // The neighbouring case: `Object.create(null)` has no `toString` of its own but
    // IS representable, so the JSON branch wins and keeps the detail.
    const bare = Object.create(null) as Record<string, unknown>;
    bare.code = "ENOENT";
    expect(errorText(bare)).toBe('{"code":"ENOENT"}');
  });

  test("a long object is cut, so one error cannot flood the log", () => {
    const big = { data: "z".repeat(5000) };
    const text = errorText(big);
    expect(text.length).toBeLessThanOrEqual(201);
    expect(text.endsWith("…")).toBe(true);
  });

  test("null, undefined and symbols stay readable", () => {
    expect(errorText(null)).toBe("null");
    expect(errorText(undefined)).toBe("undefined");
    expect(errorText(Symbol("nope"))).toBe("Symbol(nope)");
    expect(errorText(42)).toBe("42");
  });
});

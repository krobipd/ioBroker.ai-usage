import { chatgptAccountId, jwtClaims, jwtExpiry } from "./jwt";

/**
 * Build a JWT-shaped string with the given payload (no signature — we never verify one).
 *
 * @param payload the claims
 * @returns the compact token
 */
function token(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

describe("jwtClaims", () => {
  test("reads the payload of a well-formed token", () => {
    expect(jwtClaims(token({ a: 1 }))).toEqual({ a: 1 });
  });

  test("anything that is not a readable token yields null instead of throwing", () => {
    expect(jwtClaims("nope")).toBeNull();
    expect(jwtClaims("a.b.c")).toBeNull();
    expect(jwtClaims("")).toBeNull();
  });
});

describe("jwtExpiry", () => {
  test("uses the token's own expiry, converted to milliseconds", () => {
    expect(jwtExpiry(token({ exp: 1_700_000_000 }), 5_000, 1_000)).toBe(1_700_000_000_000);
  });

  test("falls back to the given lifetime when the token carries no expiry", () => {
    expect(jwtExpiry(token({}), 5_000, 1_000)).toBe(6_000);
    expect(jwtExpiry("garbage", 5_000, 1_000)).toBe(6_000);
  });
});

describe("chatgptAccountId", () => {
  test("reads the namespaced claim the ChatGPT usage call needs", () => {
    expect(chatgptAccountId(token({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-9" } }))).toBe("acc-9");
  });

  test("absent or malformed claims yield undefined, never an empty header value", () => {
    expect(chatgptAccountId(token({}))).toBeUndefined();
    expect(chatgptAccountId(token({ "https://api.openai.com/auth": { chatgpt_account_id: "" } }))).toBeUndefined();
    expect(chatgptAccountId("nope")).toBeUndefined();
  });
});

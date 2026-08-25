import { FetchError } from "../provider";
import { openRouterProvider, parseOpenRouterKeyInfo } from "./openrouter";

describe("parseOpenRouterKeyInfo", () => {
  test("maps usage/limit to credits and lifetime costs", () => {
    const snapshot = parseOpenRouterKeyInfo({
      data: { label: "key", usage: 41.2, limit: 100, is_free_tier: false },
    });
    expect(snapshot.credits).toEqual({ used: 41.2, limit: 100, remaining: 58.8, percent: 41.2, currency: "USD" });
    expect(snapshot.costs).toEqual({ total: 41.2, currency: "USD" });
  });

  test("accepts the community-observed field names credits_used/credit_limit", () => {
    const snapshot = parseOpenRouterKeyInfo({ data: { credits_used: 5, credit_limit: 10 } });
    expect(snapshot.credits).toMatchObject({ used: 5, limit: 10, remaining: 5, percent: 50 });
  });

  test("an unlimited key (limit null) yields no limit/percent", () => {
    const snapshot = parseOpenRouterKeyInfo({ data: { usage: 12.5, limit: null } });
    expect(snapshot.credits).toMatchObject({ used: 12.5, currency: "USD" });
    expect(snapshot.credits?.limit).toBeUndefined();
    expect(snapshot.credits?.percent).toBeUndefined();
  });

  test("a malformed body is a network error, not a crash", () => {
    expect(() => parseOpenRouterKeyInfo({})).toThrow(FetchError);
    expect(() => parseOpenRouterKeyInfo(null)).toThrow(FetchError);
  });
});

describe("openRouterProvider", () => {
  test("calls the key-info URL with the bearer key", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const provider = openRouterProvider("sk-or-123", (url, headers) => {
      calls.push({ url, headers });
      return Promise.resolve({ data: { usage: 1 } });
    });
    await provider.fetch();
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/auth/key");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-or-123");
  });
});

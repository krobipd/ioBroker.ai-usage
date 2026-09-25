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

  test("the percentage measures the RUNNING period against the limit, not the key's whole life", () => {
    // Decision 94. `usage` is lifetime spend; `limit` restarts with `limit_reset`.
    // A monthly limit of 100 with 250 spent over the key's life read as 250 %.
    const snapshot = parseOpenRouterKeyInfo({
      data: { usage: 250, limit: 100, limit_remaining: 80, limit_reset: "monthly", usage_monthly: 20 },
    });
    expect(snapshot.credits).toEqual({ used: 20, limit: 100, remaining: 80, percent: 20, currency: "USD" });
    // The lifetime figure stays where its name says so.
    expect(snapshot.costs?.total).toBe(250);
  });

  test("today's and this month's spend come from the key's own daily and monthly usage", () => {
    // Decision 95 — "credit usage (in USD) for the current UTC day/month".
    const now = Date.UTC(2026, 8, 10, 12);
    const snapshot = parseOpenRouterKeyInfo(
      { data: { usage: 90, usage_daily: 1.234, usage_monthly: 12, limit: null } },
      now,
    );
    expect(snapshot.costs).toEqual({ total: 90, today: 1.23, month: 12, projectedMonth: 36, currency: "USD" });
  });

  test("without the daily/monthly figures no such datapoint is invented", () => {
    const snapshot = parseOpenRouterKeyInfo({ data: { usage: 5 } });
    expect(snapshot.costs).toEqual({ total: 5, currency: "USD" });
  });

  test("an answer without a single usable figure creates no credits block", () => {
    // Decision 6: a capability without a usable value gets no datapoint. The block
    // used to be a plain literal, so an empty `data` still produced a bare channel.
    expect(parseOpenRouterKeyInfo({ data: {} }).credits).toBeUndefined();
  });

  test("a malformed body is a SERVICE fault, not a network error", () => {
    // The class is the point, not the throw: OpenRouter answered, we could not read
    // it (decision 21). As `network` it would have been tolerated three times and
    // then reported as "no connection" — about a host that had replied.
    for (const body of [{}, null]) {
      expect(() => parseOpenRouterKeyInfo(body)).toThrow(FetchError);
      expect(() => parseOpenRouterKeyInfo(body)).toThrow(expect.objectContaining({ kind: "service" }));
    }
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
    // The path of the current API reference — `/auth/key` is no longer in it.
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/key");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-or-123");
  });

  test("the adapter's own identity rides along where it is given", async () => {
    const calls: Record<string, string>[] = [];
    const provider = openRouterProvider(
      "k",
      (_url, headers) => {
        calls.push(headers);
        return Promise.resolve({ data: { usage: 1 } });
      },
      () => 0,
      "ioBroker.ai-usage/0.16.0",
    );
    await provider.fetch();
    expect(calls[0]["User-Agent"]).toBe("ioBroker.ai-usage/0.16.0");
  });
});

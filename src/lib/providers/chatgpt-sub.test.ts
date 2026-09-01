import { FetchError, type TokenSet, type TokenStore } from "../provider";
import { pollDeviceCode, startDeviceCode, type DeviceCodeStart } from "./chatgpt-auth";
import { chatgptSubProvider, parseChatgptResetCredits, parseChatgptUsage } from "./chatgpt-sub";

/**
 * A token store backed by memory.
 *
 * @param initial the stored tokens, or null
 * @returns the store plus what was saved
 */
function memoryStore(initial: TokenSet | null): TokenStore & { saved: TokenSet[] } {
  const store = {
    saved: [] as TokenSet[],
    load: () => Promise.resolve(initial),
    save: (tokens: TokenSet) => {
      store.saved.push(tokens);
      return Promise.resolve();
    },
    clear: () => Promise.resolve(),
  };
  return store;
}

describe("parseChatgptUsage", () => {
  test("reads the 5-hour and weekly windows with their reset time", () => {
    const snapshot = parseChatgptUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 15, reset_at: 1735401600, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 5, reset_at: 1735920000, limit_window_seconds: 604800 },
      },
      credits: { has_credits: true, unlimited: false, balance: 150 },
    });
    expect(snapshot.limits).toEqual([
      { name: "session", label: "Session (5 h)", percent: 15, resetAt: "2024-12-28T16:00:00.000Z" },
      { name: "week", label: "Week", percent: 5, resetAt: "2025-01-03T16:00:00.000Z" },
    ]);
    expect(snapshot.credits).toEqual({ remaining: 150, currency: "USD" });
  });

  test("a null window is left out instead of being reported as 0 %", () => {
    const snapshot = parseChatgptUsage({
      rate_limit: { primary_window: { used_percent: 42 }, secondary_window: null },
    });
    expect(snapshot.limits).toEqual([{ name: "session", label: "Session (5 h)", percent: 42 }]);
  });

  test("unlimited credits produce no credit values", () => {
    const snapshot = parseChatgptUsage({ credits: { unlimited: true, balance: 0 } });
    expect(snapshot.credits).toBeUndefined();
  });

  test("an extra limit is added under its own name", () => {
    const snapshot = parseChatgptUsage({
      rate_limit: { primary_window: { used_percent: 10 } },
      additional_rate_limits: [{ limit_name: "GPT-5 Pro", rate_limit: { used_percent: 60 } }],
    });
    expect(snapshot.limits).toEqual([
      { name: "session", label: "Session (5 h)", percent: 10 },
      { name: "gpt-5-pro", label: "GPT-5 Pro", percent: 60, scoped: true },
    ]);
  });

  test("an extra limit cannot overwrite a window that is already there", () => {
    const snapshot = parseChatgptUsage({
      rate_limit: { primary_window: { used_percent: 10 } },
      additional_rate_limits: [{ limit_name: "Session", rate_limit: { used_percent: 99 } }],
    });
    expect(snapshot.limits).toEqual([{ name: "session", label: "Session (5 h)", percent: 10 }]);
  });

  test("an extra limit whose name carries no usable characters is skipped", () => {
    const snapshot = parseChatgptUsage({
      additional_rate_limits: [{ limit_name: "###", rate_limit: { used_percent: 20 } }],
    });
    expect(snapshot.limits).toBeUndefined();
  });

  test("a non-object answer is a network failure, not a silent empty snapshot", () => {
    expect(() => parseChatgptUsage("nope")).toThrow(FetchError);
  });
});

describe("device-code sign-in", () => {
  test("the interval arrives as a string and is never faster than one second", async () => {
    const start = await startDeviceCode(
      () => Promise.resolve({ device_auth_id: "d1", user_code: "ABCD-1234", interval: "0" }),
      1_000,
    );
    expect(start.userCode).toBe("ABCD-1234");
    expect(start.intervalSec).toBeGreaterThanOrEqual(1);
    expect(start.expiresAt).toBeGreaterThan(1_000);
  });

  test("'not confirmed yet' arrives as an auth error and counts as waiting", async () => {
    const handle: DeviceCodeStart = { userCode: "A", deviceAuthId: "d", intervalSec: 5, expiresAt: 0 };
    const result = await pollDeviceCode(handle, () => Promise.reject(new FetchError("auth", "HTTP 403")));
    expect(result.status).toBe("pending");
  });

  test("a transport failure is NOT swallowed as waiting", async () => {
    const handle: DeviceCodeStart = { userCode: "A", deviceAuthId: "d", intervalSec: 5, expiresAt: 0 };
    await expect(pollDeviceCode(handle, () => Promise.reject(new FetchError("network", "boom")))).rejects.toThrow(
      "boom",
    );
  });
});

describe("chatgptSubProvider", () => {
  test("without stored tokens the fetch asks for the sign-in", async () => {
    const provider = chatgptSubProvider(memoryStore(null), () => Promise.resolve({}), () => Promise.resolve({}), () => 0);
    await expect(provider.fetch()).rejects.toThrow(FetchError);
  });

  test("the account id is sent as a header, and only when known", async () => {
    const seen: Record<string, string>[] = [];
    const tokens: TokenSet = { accessToken: "a", refreshToken: "r", expiresAt: 10 * 60_000, accountRef: "acc-1" };
    const provider = chatgptSubProvider(
      memoryStore(tokens),
      () => Promise.resolve({}),
      (_url, headers) => {
        seen.push(headers);
        return Promise.resolve({ rate_limit: { primary_window: { used_percent: 1 } } });
      },
      () => 0,
    );
    await provider.fetch();
    expect(seen[0]["ChatGPT-Account-Id"]).toBe("acc-1");
    // The second request of the SAME fetch is the reset-voucher inventory — it
    // carries the account id too, plus the two headers OpenAI's own client sends.
    expect(seen[1]["ChatGPT-Account-Id"]).toBe("acc-1");
    expect(seen[1]["OpenAI-Beta"]).toBe("codex-1");
    expect(seen[1].originator).toBe("Codex Desktop");

    const withoutAccount = chatgptSubProvider(
      memoryStore({ accessToken: "a", refreshToken: "r", expiresAt: 10 * 60_000 }),
      () => Promise.resolve({}),
      (_url, headers) => {
        seen.push(headers);
        return Promise.resolve({});
      },
      () => 0,
    );
    await withoutAccount.fetch();
    expect(seen[2]["ChatGPT-Account-Id"]).toBeUndefined();
  });

  test("a failing voucher call never discards the usage snapshot", async () => {
    const tokens: TokenSet = { accessToken: "a", refreshToken: "r", expiresAt: 10 * 60_000 };
    const provider = chatgptSubProvider(
      memoryStore(tokens),
      () => Promise.resolve({}),
      url =>
        url.includes("rate-limit-reset-credits")
          ? Promise.reject(new FetchError("service", "HTTP 500"))
          : Promise.resolve({ rate_limit: { primary_window: { used_percent: 41 } } }),
      () => 0,
    );
    const snapshot = await provider.fetch();
    expect(snapshot.limits?.[0]?.percent).toBe(41);
    expect(snapshot.credits?.resetCredits).toBeUndefined();
  });

  test("vouchers from the inventory land in the snapshot's credits", async () => {
    // Expiry far beyond the test clock, or the provider would try a token refresh.
    const tokens: TokenSet = { accessToken: "a", refreshToken: "r", expiresAt: Date.parse("2027-01-01T00:00:00Z") };
    const provider = chatgptSubProvider(
      memoryStore(tokens),
      () => Promise.resolve({}),
      url =>
        url.includes("rate-limit-reset-credits")
          ? Promise.resolve({
              credits: [
                { id: "c1", reset_type: "codex_rate_limits", status: "available", expires_at: "2026-10-01T00:00:00Z" },
              ],
              available_count: 1,
            })
          : Promise.resolve({ rate_limit: { primary_window: { used_percent: 41 } } }),
      () => Date.parse("2026-09-01T00:00:00Z"),
    );
    const snapshot = await provider.fetch();
    expect(snapshot.credits?.resetCredits).toBe(1);
    expect(snapshot.credits?.resetCreditsNextExpiry).toBe("2026-10-01T00:00:00Z");
  });
});

describe("parseChatgptResetCredits", () => {
  const NOW = Date.parse("2026-09-01T12:00:00Z");

  test("counts available vouchers and finds the earliest future expiry", () => {
    const result = parseChatgptResetCredits(
      {
        credits: [
          { id: "a", status: "available", expires_at: "2026-10-05T00:00:00Z" },
          { id: "b", status: "available", expires_at: "2026-09-20T00:00:00Z" },
          { id: "c", status: "redeemed", expires_at: "2026-12-01T00:00:00Z" },
        ],
        available_count: 3,
      },
      NOW,
    );
    expect(result).toEqual({ count: 2, nextExpiry: "2026-09-20T00:00:00Z" });
  });

  test("a stale voucher still flagged available is skipped (CodexBar-verified server quirk)", () => {
    const result = parseChatgptResetCredits(
      {
        credits: [
          { id: "old", status: "available", expires_at: "2026-08-01T00:00:00Z" },
          { id: "new", status: "available", expires_at: "2026-09-30T00:00:00Z" },
        ],
        available_count: 2,
      },
      NOW,
    );
    expect(result).toEqual({ count: 1, nextExpiry: "2026-09-30T00:00:00Z" });
  });

  test("a voucher without an expiry counts and leaves the companion empty", () => {
    expect(parseChatgptResetCredits({ credits: [{ id: "x", status: "available" }] }, NOW)).toEqual({
      count: 1,
      nextExpiry: "",
    });
  });

  test("without a list the server count is trusted, malformed answers yield zero", () => {
    expect(parseChatgptResetCredits({ available_count: 2 }, NOW)).toEqual({ count: 2, nextExpiry: "" });
    expect(parseChatgptResetCredits({ available_count: -1 }, NOW)).toEqual({ count: 0, nextExpiry: "" });
    expect(parseChatgptResetCredits(null, NOW)).toEqual({ count: 0, nextExpiry: "" });
    expect(parseChatgptResetCredits("nope", NOW)).toEqual({ count: 0, nextExpiry: "" });
  });
});

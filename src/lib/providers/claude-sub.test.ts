import { FetchError } from "../provider";
import { buildAuthorizeUrl, exchangeCode, generatePkce, refreshTokens, type TokenSet } from "./claude-auth";
import { claudeSubProvider, parseClaudeUsage, type TokenStore } from "./claude-sub";

describe("claude-auth", () => {
  test("the authorize URL carries client id, PKCE challenge and state", () => {
    const pkce = generatePkce();
    const url = new URL(buildAuthorizeUrl(pkce));
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(pkce.state);
    expect(url.searchParams.get("scope")).toContain("user:profile");
  });

  test("exchangeCode splits code#state, validates state and posts the PKCE verifier", async () => {
    const pkce = generatePkce();
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const tokens = await exchangeCode(
      `the-code#${pkce.state}`,
      pkce,
      (url, body) => {
        posts.push({ url, body });
        return Promise.resolve({ access_token: "at", refresh_token: "rt", expires_in: 600 });
      },
      1_000_000,
    );
    expect(posts[0].url).toBe("https://console.anthropic.com/v1/oauth/token");
    expect(posts[0].body).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: pkce.verifier,
    });
    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000 + 600_000 });
  });

  test("a state mismatch is an auth error (CSRF guard)", async () => {
    const pkce = generatePkce();
    await expect(exchangeCode("code#WRONG", pkce, () => Promise.resolve({}), 0)).rejects.toThrow(FetchError);
  });

  test("refreshTokens keeps the old refresh token when the response carries none", async () => {
    const tokens: TokenSet = { accessToken: "old", refreshToken: "keep-me", expiresAt: 0 };
    const fresh = await refreshTokens(tokens, () => Promise.resolve({ access_token: "new", expires_in: 60 }), 5000);
    expect(fresh).toEqual({ accessToken: "new", refreshToken: "keep-me", expiresAt: 5000 + 60_000 });
  });
});

describe("parseClaudeUsage", () => {
  test("the limits[] array becomes the limit windows (kind + model buckets)", () => {
    const snapshot = parseClaudeUsage({
      limits: [
        { kind: "session", percent: 34, resets_at: "2026-08-25T14:00:00Z", scope: {} },
        { kind: "weekly_all", percent: 62, resets_at: "2026-09-01T09:00:00Z" },
        { kind: "weekly_scoped", percent: 71, scope: { model: { display_name: "Fable 5" } } },
      ],
      five_hour: null,
    });
    expect(snapshot.limits).toEqual([
      { name: "session", label: "Session (5 h)", percent: 34, resetAt: "2026-08-25T14:00:00Z" },
      { name: "week", label: "Week (all models)", percent: 62, resetAt: "2026-09-01T09:00:00Z" },
      { name: "weekly_scoped-Fable_5", label: "weekly scoped Fable 5", percent: 71 },
    ]);
  });

  test("falls back to the flat keys when limits[] is absent", () => {
    const snapshot = parseClaudeUsage({
      five_hour: { utilization: 12, resets_at: "2026-08-25T15:00:00Z" },
      seven_day: { utilization: 40 },
    });
    expect(snapshot.limits).toEqual([
      { name: "session", label: "Session (5 h)", percent: 12, resetAt: "2026-08-25T15:00:00Z" },
      { name: "week", label: "Week (all models)", percent: 40 },
    ]);
  });

  test("extra_usage (credits schema) maps to credits and monthly costs", () => {
    const snapshot = parseClaudeUsage({
      extra_usage: { is_enabled: true, utilization: 16, used_credits: 320, monthly_limit: 2000, decimal_places: 2 },
    });
    expect(snapshot.credits).toMatchObject({ used: 3.2, limit: 20, percent: 16, currency: "USD" });
    expect(snapshot.costs).toEqual({ month: 3.2, currency: "USD" });
  });

  test("spend (money schema) maps amount_minor/exponent", () => {
    const snapshot = parseClaudeUsage({
      spend: {
        enabled: true,
        percent: 10,
        used: { amount_minor: 450, currency: "USD", exponent: 2 },
        limit: null,
      },
    });
    expect(snapshot.credits).toMatchObject({ used: 4.5, percent: 10 });
    expect(snapshot.credits?.limit).toBeUndefined();
    expect(snapshot.costs).toEqual({ month: 4.5, currency: "USD" });
  });

  test("a malformed body is a network error", () => {
    expect(() => parseClaudeUsage(null)).toThrow(FetchError);
  });
});

describe("claudeSubProvider", () => {
  const validTokens: TokenSet = { accessToken: "at", refreshToken: "rt", expiresAt: 10_000_000 };

  function memoryStore(initial: TokenSet | null): TokenStore & { saved: TokenSet[] } {
    const store = {
      saved: [] as TokenSet[],
      load: () => Promise.resolve(initial),
      save: (tokens: TokenSet) => {
        store.saved.push(tokens);
        return Promise.resolve();
      },
    };
    return store;
  }

  test("without stored tokens the fetch is an auth error (sign-in required)", async () => {
    const provider = claudeSubProvider(
      memoryStore(null),
      () => Promise.resolve({}),
      () => Promise.resolve({}),
      () => 0,
    );
    await expect(provider.fetch()).rejects.toMatchObject({ kind: "auth" });
  });

  test("a valid token fetches usage with bearer + beta header", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const provider = claudeSubProvider(
      memoryStore(validTokens),
      (url, headers) => {
        calls.push({ url, headers });
        return Promise.resolve({ limits: [{ kind: "session", percent: 5 }] });
      },
      () => Promise.reject(new Error("refresh must not run")),
      () => 1000,
    );
    const snapshot = await provider.fetch();
    expect(calls[0].url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(calls[0].headers.Authorization).toBe("Bearer at");
    expect(calls[0].headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(snapshot.limits?.[0].percent).toBe(5);
  });

  test("an expiring token is refreshed and persisted before the usage call", async () => {
    const store = memoryStore({ accessToken: "stale", refreshToken: "rt", expiresAt: 1000 });
    const usedTokens: string[] = [];
    const provider = claudeSubProvider(
      store,
      (_url, headers) => {
        usedTokens.push(headers.Authorization);
        return Promise.resolve({ limits: [] });
      },
      () => Promise.resolve({ access_token: "fresh", refresh_token: "rt2", expires_in: 3600 }),
      () => 5000, // past expiresAt - 60 s
    );
    await provider.fetch();
    expect(usedTokens[0]).toBe("Bearer fresh");
    expect(store.saved[0]).toMatchObject({ accessToken: "fresh", refreshToken: "rt2" });
  });
});

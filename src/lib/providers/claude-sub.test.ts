import { FetchError, type TokenSet, type TokenStore } from "../provider";
import { buildAuthorizeUrl, exchangeCode, generatePkce, refreshTokens } from "./claude-auth";
import { claudeSubProvider, parseClaudeUsage } from "./claude-sub";

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
    await expect(exchangeCode("code#WRONG", pkce, () => Promise.resolve({}), 0)).rejects.toMatchObject({
      kind: "auth",
    });
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
      {
        name: "session",
        label: "Session (5 h)",
        labelKey: "nameWindowSession",
        percent: 34,
        resetAt: "2026-08-25T14:00:00Z",
      },
      {
        name: "week",
        label: "Week (all models)",
        labelKey: "nameWindowWeek",
        percent: 62,
        resetAt: "2026-09-01T09:00:00Z",
      },
      {
        name: "weekly_scoped-Fable_5",
        label: "weekly scoped Fable 5",
        labelKey: "nameWindowModelWeek",
        labelArg: "Fable 5",
        percent: 71,
        scoped: true,
      },
    ]);
  });

  test("falls back to the flat keys when limits[] is absent", () => {
    const snapshot = parseClaudeUsage({
      five_hour: { utilization: 12, resets_at: "2026-08-25T15:00:00Z" },
      seven_day: { utilization: 40 },
    });
    expect(snapshot.limits).toEqual([
      {
        name: "session",
        label: "Session (5 h)",
        labelKey: "nameWindowSession",
        percent: 12,
        resetAt: "2026-08-25T15:00:00Z",
      },
      { name: "week", label: "Week (all models)", labelKey: "nameWindowWeek", percent: 40 },
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

  test("null in the extra-usage block invents no zero credits", () => {
    // `Number(null)` is 0, and this block was the last place still using the raw
    // conversion: a $0 ceiling and a $0 month written as fact, into total.costs.month
    // with it. The fleet guard (`coerceFiniteNumber` at every API boundary) applies
    // here like everywhere else.
    const snapshot = parseClaudeUsage({
      limits: [{ kind: "session", percent: 5 }],
      extra_usage: { is_enabled: true, used_credits: null, monthly_limit: null, utilization: null },
    });
    expect(snapshot.credits?.used).toBeUndefined();
    expect(snapshot.credits?.limit).toBeUndefined();
    expect(snapshot.credits?.percent).toBeUndefined();
    expect(snapshot.costs).toBeUndefined();
  });

  test("null in the spend block does the same", () => {
    const snapshot = parseClaudeUsage({
      limits: [{ kind: "session", percent: 5 }],
      spend: { enabled: true, used: { amount_minor: null, exponent: 2 }, limit: null, percent: null },
    });
    expect(snapshot.credits?.used).toBeUndefined();
    expect(snapshot.costs).toBeUndefined();
  });

  test("a malformed body is a SERVICE fault, not a network error", () => {
    // Decision 21 — and the class is what the user sees: `network` spends three
    // rounds in silence and then claims the host is unreachable.
    expect(() => parseClaudeUsage(null)).toThrow(expect.objectContaining({ kind: "service" }));
  });

  test("a body carrying NONE of the known fields is a service fault, not an empty account", () => {
    // Schema drift. Read as "the account reports nothing" it switched every alarm
    // off in silence and let the orphan sweep take the whole limit tree with it.
    expect(() => parseClaudeUsage({ something_new: { session: 12 } })).toThrow(
      expect.objectContaining({ kind: "service" }),
    );
    try {
      parseClaudeUsage({ something_new: {} });
    } catch (e) {
      expect((e as FetchError).kind).toBe("service");
    }
  });

  test("an account that has used nothing yet is a valid EMPTY snapshot", () => {
    // The counter-test to the guard above: the keys are there, the values are null
    // (which is what the provider sends before the first use of a window). That is
    // a legitimate empty answer and must NOT be reported as a broken service.
    const snapshot = parseClaudeUsage({
      five_hour: { utilization: null, resets_at: null },
      seven_day: { utilization: null, resets_at: null },
      extra_usage: { is_enabled: false },
    });
    expect(snapshot.limits).toBeUndefined();
    expect(snapshot.credits).toBeUndefined();
  });
});

describe("claudeSubProvider", () => {
  const validTokens: TokenSet = { accessToken: "at", refreshToken: "rt", expiresAt: 10_000_000 };

  function memoryStore(initial: TokenSet | null): TokenStore & { saved: TokenSet[] } {
    const store = {
      saved: [] as TokenSet[],
      current: initial,
      load: () => Promise.resolve(store.current),
      save: (tokens: TokenSet) => {
        store.current = tokens;
        store.saved.push(tokens);
        return Promise.resolve();
      },
      // Mirrors the real store: the compare-and-swap comes FIRST, so a sign-out that
      // landed during the refresh is not undone by the write that follows it.
      replace: (previous: TokenSet, next: TokenSet) => {
        if (store.current !== previous) {
          return Promise.resolve();
        }
        store.current = next;
        store.saved.push(next);
        return Promise.resolve();
      },
      clear: () => {
        store.current = null;
        return Promise.resolve();
      },
    };
    return store;
  }

  test("without stored tokens the fetch says NO CREDENTIALS, not rejected", async () => {
    const provider = claudeSubProvider(
      memoryStore(null),
      () => Promise.resolve({}),
      () => Promise.resolve({}),
      () => 0,
    );
    // The split that keeps a brand-new account out of the warning/notification
    // path: nobody has signed in yet, the provider has rejected nothing.
    await expect(provider.fetch()).rejects.toMatchObject({ kind: "no-credentials" });
  });

  test("a valid token fetches usage with bearer + beta header", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const provider = claudeSubProvider(
      memoryStore(validTokens),
      () => Promise.reject(new Error("refresh must not run")),
      (url, headers) => {
        calls.push({ url, headers });
        return Promise.resolve({ limits: [{ kind: "session", percent: 5 }] });
      },
      () => 1000,
    );
    const snapshot = await provider.fetch();
    expect(calls[0].url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(calls[0].headers.Authorization).toBe("Bearer at");
    expect(calls[0].headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    // Design decision 20: the throttle bucket keys on the sender identity. Our own
    // name landed in the aggressive bucket with permanent 429s — a regression here
    // would be invisible in every other test.
    expect(calls[0].headers["User-Agent"]).toMatch(/^claude-code\//);
    expect(calls[0].headers["User-Agent"]).not.toContain("ioBroker");
    expect(snapshot.limits?.[0].percent).toBe(5);
  });

  test("an expiring token is refreshed and persisted before the usage call", async () => {
    const store = memoryStore({ accessToken: "stale", refreshToken: "rt", expiresAt: 1000 });
    const usedTokens: string[] = [];
    const provider = claudeSubProvider(
      store,
      () => Promise.resolve({ access_token: "fresh", refresh_token: "rt2", expires_in: 3600 }),
      (_url, headers) => {
        usedTokens.push(headers.Authorization);
        return Promise.resolve({ limits: [] });
      },
      () => 5000, // past expiresAt - 60 s
    );
    await provider.fetch();
    expect(usedTokens[0]).toBe("Bearer fresh");
    expect(store.saved[0]).toMatchObject({ accessToken: "fresh", refreshToken: "rt2" });
  });
});

describe("the fields 0.12.0 started reading", () => {
  const payload = {
    five_hour: { utilization: 8, resets_at: "2026-09-06T14:09:59.898660+00:00", locked_reason: null },
    seven_day: { utilization: 54, resets_at: "2026-09-07T18:59:59.898682+00:00", locked_reason: null },
    limits: [
      { kind: "session", group: "session", percent: 8, severity: "normal", is_active: false, scope: null },
      { kind: "weekly_all", group: "weekly", percent: 54, severity: "normal", is_active: false, scope: null },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 97,
        severity: "critical",
        is_active: true,
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      },
    ],
  };

  test("is_active is carried through per window (live payload, 2026-09-06)", () => {
    const snapshot = parseClaudeUsage(payload);
    expect(snapshot.limits?.map(limit => [limit.name, limit.active])).toEqual([
      ["session", false],
      ["week", false],
      ["weekly_scoped-Fable", true],
    ]);
  });

  test("locked_reason rides in from the flat block onto its window", () => {
    // It sits on five_hour/seven_day only — the limits[] entries do not carry it.
    const snapshot = parseClaudeUsage({
      ...payload,
      seven_day: { ...payload.seven_day, locked_reason: "usage_limit_reached" },
    });
    const week = snapshot.limits?.find(limit => limit.name === "week");
    expect(week?.lockedReason).toBe("usage_limit_reached");
    expect(snapshot.limits?.find(limit => limit.name === "session")?.lockedReason).toBeUndefined();
  });

  test("a null percentage is left out instead of counting as 0 %", () => {
    // Number(null) is 0 — a bucket the account has no allowance for would have
    // been reported as "nothing used yet".
    const snapshot = parseClaudeUsage({ limits: [{ kind: "session", percent: null }] });
    expect(snapshot.limits).toBeUndefined();
  });
});

describe("what the audit of 2026-09-15 found", () => {
  /**
   * A store that behaves like the adapter's: the CAS gate comes before the write.
   *
   * @param initial the tokens the store starts with
   * @returns the store, with its content readable for assertions
   */
  function auditStore(initial: TokenSet | null): TokenStore & { current: TokenSet | null } {
    const store = {
      current: initial,
      load: () => Promise.resolve(store.current),
      save: (next: TokenSet) => {
        store.current = next;
        return Promise.resolve();
      },
      replace: (previous: TokenSet, next: TokenSet) => {
        if (store.current === previous) {
          store.current = next;
        }
        return Promise.resolve();
      },
      clear: () => {
        store.current = null;
        return Promise.resolve();
      },
    };
    return store;
  }

  // Both recordings of the 2026-09-06 live answer held in this repo (this file and
  // test/fixtures/inventory/responses.cjs) carry no `resets_at` on the session entry
  // while the flat block has it — the window's end was known and the datapoint
  // stayed empty.
  const payload = {
    five_hour: { utilization: 8, resets_at: "2026-09-06T14:09:59.898660+00:00", locked_reason: null },
    seven_day: { utilization: 54, resets_at: "2026-09-07T18:59:59.898682+00:00", locked_reason: null },
    limits: [
      { kind: "session", group: "session", percent: 8, severity: "normal", is_active: false, scope: null },
      { kind: "weekly_all", group: "weekly", percent: 54, severity: "normal", is_active: false, scope: null },
    ],
  };

  test("the session window takes its reset time from the flat block when the entry has none", () => {
    const snapshot = parseClaudeUsage(payload);
    expect(snapshot.limits?.map(limit => [limit.name, limit.resetAt])).toEqual([
      ["session", "2026-09-06T14:09:59.898660+00:00"],
      ["week", "2026-09-07T18:59:59.898682+00:00"],
    ]);
  });

  test("an entry that carries its own reset time keeps it", () => {
    const own = {
      ...payload,
      limits: [{ ...payload.limits[0], resets_at: "2026-09-06T15:00:00.000000+00:00" }],
    };
    expect(parseClaudeUsage(own).limits?.[0].resetAt).toBe("2026-09-06T15:00:00.000000+00:00");
  });

  test("a model window has no flat block and stays empty", () => {
    // `resets_at` sits on five_hour/seven_day only — a scoped window must not
    // inherit the session's time just because one exists.
    const scoped = {
      ...payload,
      limits: [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 97,
          severity: "critical",
          is_active: true,
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
        },
      ],
    };
    expect(parseClaudeUsage(scoped).limits?.[0].resetAt).toBeUndefined();
  });

  test("a rejected access token is refreshed once and the usage call repeated", async () => {
    // A token the provider invalidated BEFORE its expiry used to report "sign-in
    // rejected" until the stored expiry was reached — up to eight hours.
    const store = auditStore({ accessToken: "stale", refreshToken: "rt1", expiresAt: 10 * 60_000 });
    const used: string[] = [];
    const provider = claudeSubProvider(
      store,
      () => Promise.resolve({ access_token: "fresh", refresh_token: "rt2", expires_in: 3600 }),
      (_url, headers) => {
        used.push(String(headers.Authorization));
        if (used.length === 1) {
          return Promise.reject(new FetchError("auth", "HTTP 401"));
        }
        return Promise.resolve({ five_hour: { utilization: 8 } });
      },
      () => 0,
    );
    const snapshot = await provider.fetch();
    expect(used).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(snapshot.limits?.[0].percent).toBe(8);
    expect((await store.load())?.refreshToken).toBe("rt2");
  });

  test("a second rejection is the real answer — exactly one retry", async () => {
    const store = auditStore({ accessToken: "stale", refreshToken: "rt1", expiresAt: 10 * 60_000 });
    let calls = 0;
    const provider = claudeSubProvider(
      store,
      () => Promise.resolve({ access_token: "fresh", refresh_token: "rt2", expires_in: 3600 }),
      () => {
        calls++;
        return Promise.reject(new FetchError("auth", "HTTP 401"));
      },
      () => 0,
    );
    await expect(provider.fetch()).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toBe(2);
  });
});

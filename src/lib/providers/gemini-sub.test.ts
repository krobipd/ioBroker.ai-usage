import { FetchError, type TokenSet, type TokenStore } from "../provider";
import { buildGeminiAuthorizeUrl, extractGeminiCode, generateGeminiPkce } from "./gemini-auth";
import {
  GEMINI_IDENTITY,
  geminiSubProvider,
  noProjectReason,
  parseCodeAssist,
  parseGeminiPools,
  parseGeminiQuota,
} from "./gemini-sub";

/**
 * A token store backed by memory.
 *
 * @param initial the stored tokens, or null
 * @returns the store plus what was saved
 */
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

describe("gemini sign-in", () => {
  test("the authorize link carries the loopback redirect Google accepts", () => {
    const url = new URL(buildGeminiAuthorizeUrl(generateGeminiPkce()));
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:51121/oauth-callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  test("the pasted browser address is accepted, code and state are read out of it", () => {
    const code = extractGeminiCode("http://localhost:51121/oauth-callback?code=4/abc&state=s1&scope=x", "s1");
    expect(code).toBe("4/abc");
  });

  test("a bare code is accepted too", () => {
    expect(extractGeminiCode("  4/plain  ", "s1")).toBe("4/plain");
  });

  test("an address from a different attempt is refused (cross-site check)", () => {
    expect(() => extractGeminiCode("http://x/?code=4/abc&state=other", "s1")).toThrow(
      expect.objectContaining({ kind: "auth" }),
    );
  });

  test("an address carrying Google's error is reported with that reason", () => {
    expect(() => extractGeminiCode("http://x/?error=access_denied", "s1")).toThrow(/access_denied/);
  });
});

describe("parseGeminiQuota", () => {
  test("remaining fraction becomes utilisation in percent", () => {
    const snapshot = parseGeminiQuota({
      buckets: [
        {
          modelId: "gemini-2.5-pro",
          tokenType: "REQUESTS",
          remainingFraction: 0.75,
          resetTime: "2026-08-27T16:01:15Z",
        },
        { modelId: "gemini-2.5-flash", remainingFraction: 0.2 },
      ],
    });
    expect(snapshot.limits).toEqual([
      // NOT marked as model windows: Google has no plan-wide bucket, so these ARE
      // the plan (decision 80). The fullest one speaks, and the warning names it.
      {
        name: "gemini-2_5-pro",
        label: "gemini-2.5-pro",
        labelKey: "nameWindowQuota",
        labelArg: "gemini-2.5-pro",
        percent: 25,
        resetAt: "2026-08-27T16:01:15Z",
      },
      {
        name: "gemini-2_5-flash",
        label: "gemini-2.5-flash",
        labelKey: "nameWindowQuota",
        labelArg: "gemini-2.5-flash",
        percent: 80,
      },
    ]);
  });

  test("a bucket without a usable fraction is skipped, not invented as 0 %", () => {
    const snapshot = parseGeminiQuota({ buckets: [{ modelId: "x" }, { modelId: "y", remainingFraction: "nope" }] });
    expect(snapshot.limits).toBeUndefined();
  });

  test("a non-object answer is a SERVICE fault, not a network failure", () => {
    // Decision 21 — Google answered, the shape is not ours.
    expect(() => parseGeminiQuota(42)).toThrow(expect.objectContaining({ kind: "service" }));
  });
});

describe("parseCodeAssist", () => {
  test("project and tier are read, paid tier wins over the current one", () => {
    expect(
      parseCodeAssist({
        cloudaicompanionProject: "proj-1",
        currentTier: { id: "free-tier", name: "Free" },
        paidTier: { id: "ultra", name: "Google AI Ultra" },
      }),
    ).toEqual({ project: "proj-1", tier: "Google AI Ultra", hasCurrentTier: true, ineligible: [] });
  });

  test("without a project, the reason is Google's own (decision 99)", () => {
    // gemini-cli `setup.ts` tells these apart; "subscription required" for all of
    // them misled a paying user who had just never set the account up.
    expect(
      noProjectReason(
        parseCodeAssist({
          ineligibleTiers: [
            { reasonCode: "VALIDATION_REQUIRED", reasonMessage: "Verify", validationUrl: "https://g.co/verify" },
          ],
        }),
      ),
    ).toBe("Google asks for a one-time account verification — https://g.co/verify");
    expect(
      noProjectReason(
        parseCodeAssist({ ineligibleTiers: [{ reasonCode: "RESTRICTED_AGE", reasonMessage: "Too young" }] }),
      ),
    ).toBe("Google does not offer Code Assist to this account — Too young");
    expect(noProjectReason(parseCodeAssist({}))).toContain("not set up for Code Assist yet");
    expect(noProjectReason(parseCodeAssist({ currentTier: { id: "standard-tier" } }))).toContain("subscription");
  });
});

describe("geminiSubProvider", () => {
  test("both calls carry the identity that decides which buckets Google returns", async () => {
    const calls: { url: string; body: unknown; headers?: Record<string, string> }[] = [];
    const provider = geminiSubProvider(
      memoryStore({ accessToken: "a", refreshToken: "r", expiresAt: 10 * 60_000 }),
      (url, body, options) => {
        calls.push({ url, body, headers: options?.headers });
        return Promise.resolve(
          url.endsWith("loadCodeAssist")
            ? { cloudaicompanionProject: "proj-1" }
            : { buckets: [{ modelId: "m", remainingFraction: 0.5 }] },
        );
      },
      () => Promise.resolve({}),
      () => 0,
    );
    const snapshot = await provider.fetch();
    expect(calls[0].body).toEqual({ metadata: { ideType: GEMINI_IDENTITY.ideType } });
    expect(calls[0].headers?.["User-Agent"]).toBe(GEMINI_IDENTITY.userAgent);
    expect(calls[1].headers?.["User-Agent"]).toBe(GEMINI_IDENTITY.userAgent);
    expect(calls[1].body).toEqual({ project: "proj-1" });
    expect(snapshot.limits?.[0].percent).toBe(50);
  });

  test("an account without a project is reported with Google's own reason, as a service answer", async () => {
    const provider = geminiSubProvider(
      memoryStore({ accessToken: "a", refreshToken: "r", expiresAt: 10 * 60_000 }),
      () => Promise.resolve({ ineligibleTiers: [{ reasonCode: "INELIGIBLE_ACCOUNT" }] }),
      () => Promise.resolve({}),
      () => 0,
    );
    // NOT `auth`: the sign-in worked, the account simply has no Code-Assist project
    // — sending the user through a sign-in cannot change that answer.
    // `toThrow` checks the message text itself.
    const failure = provider.fetch();
    await expect(failure).rejects.toMatchObject({ kind: "service" });
    await expect(failure).rejects.toThrow(/INELIGIBLE_ACCOUNT/);
  });

  test("the second host is tried when the first one fails on transport", async () => {
    const tried: string[] = [];
    const provider = geminiSubProvider(
      memoryStore({ accessToken: "a", refreshToken: "r", expiresAt: 10 * 60_000, accountRef: "proj-1" }),
      url => {
        tried.push(url);
        if (tried.length === 1) {
          return Promise.reject(new FetchError("rate-limit", "HTTP 429"));
        }
        return Promise.resolve({ buckets: [{ modelId: "m", remainingFraction: 1 }] });
      },
      () => Promise.resolve({}),
      () => 0,
    );
    await provider.fetch();
    // The quota call only — the pool summary follows on its own hosts.
    expect(tried.filter(url => url.endsWith(":retrieveUserQuota"))).toHaveLength(2);
    expect(tried[0]).toContain("daily-cloudcode-pa");
    expect(tried[1]).toContain("//cloudcode-pa");
  });

  test("an auth failure is NOT retried against the second host", async () => {
    const tried: string[] = [];
    const provider = geminiSubProvider(
      memoryStore({ accessToken: "a", refreshToken: "r", expiresAt: 10 * 60_000, accountRef: "p" }),
      url => {
        tried.push(url);
        return Promise.reject(new FetchError("auth", "HTTP 401"));
      },
      () => Promise.resolve({}),
      () => 0,
    );
    await expect(provider.fetch()).rejects.toThrow(FetchError);
    expect(tried).toHaveLength(1);
  });
});

describe("null is not zero", () => {
  test("a bucket with a null remaining fraction is skipped, not reported as full", () => {
    // Number(null) is 0, and 1 - 0 is 100 % used — an invented "you are out".
    expect(parseGeminiQuota({ buckets: [{ modelId: "m", remainingFraction: null }] }).limits).toBeUndefined();
  });
});

describe("an account without a Code-Assist project", () => {
  test("is a service answer, not a rejected sign-in", async () => {
    // Reported as `auth` it sent the user through a sign-in that cannot change
    // the answer — the account simply has no Google AI subscription.
    const provider = geminiSubProvider(
      memoryStore({ accessToken: "a", refreshToken: "r", expiresAt: 10 * 60_000 }),
      () => Promise.resolve({}),
      () => Promise.resolve({}),
      () => 0,
    );
    await expect(provider.fetch()).rejects.toMatchObject({ kind: "service" });
  });
});

describe("audit 2026-09-25 — Google", () => {
  const signedIn = (): TokenStore & { saved: TokenSet[] } =>
    memoryStore({ accessToken: "a", refreshToken: "r", expiresAt: 10 * 60_000, accountRef: "proj-1" });

  const POOLS = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "g-5h", window: "5h", displayName: "5 hours", remainingFraction: 0.1 },
          { bucketId: "g-week", window: "weekly", displayName: "Week", remainingFraction: 0.5 },
        ],
      },
    ],
  };

  test("R12: the same model twice — the fuller bucket stands for it", () => {
    const snapshot = parseGeminiQuota({
      buckets: [
        { modelId: "m", remainingFraction: 0.9 },
        { modelId: "m", remainingFraction: 0 },
      ],
    });
    expect(snapshot.limits?.map(window => window.percent)).toEqual([100]);
  });

  test("A9: a 403 on the quota query is Google saying no, not a dead sign-in", async () => {
    let refreshes = 0;
    const provider = geminiSubProvider(
      signedIn(),
      () => Promise.reject(new FetchError("auth", "HTTP 403 — PERMISSION_DENIED", { status: 403 })),
      () => {
        refreshes++;
        return Promise.resolve({ access_token: "b", expires_in: 3600 });
      },
      () => 0,
    );
    const failure = provider.fetch();
    await expect(failure).rejects.toMatchObject({ kind: "service" });
    await expect(failure).rejects.toThrow(/does not permit/);
    expect(refreshes).toBe(0);
  });

  test("A9: a 401 still refreshes once, as before", async () => {
    let calls = 0;
    let refreshes = 0;
    const provider = geminiSubProvider(
      signedIn(),
      url => {
        if (url.endsWith(":retrieveUserQuota")) {
          calls++;
          return calls === 1
            ? Promise.reject(new FetchError("auth", "HTTP 401", { status: 401 }))
            : Promise.resolve({ buckets: [{ modelId: "m", remainingFraction: 0.5 }] });
        }
        return Promise.resolve({});
      },
      () => {
        refreshes++;
        return Promise.resolve({ access_token: "b", expires_in: 3600 });
      },
      () => 0,
    );
    await provider.fetch();
    expect(refreshes).toBe(1);
  });

  test("P-D3: the pools are parsed as plan-wide windows", () => {
    const pools = parseGeminiPools(POOLS);
    expect(pools.map(window => [window.name, window.percent, window.scoped, window.labelKey])).toEqual([
      ["pool-Gemini_Models-g-5h", 90, undefined, "nameWindowPool"],
      ["pool-Gemini_Models-g-week", 50, undefined, "nameWindowPool"],
    ]);
    expect(parseGeminiPools({})).toEqual([]);
    expect(parseGeminiPools({ groups: [{ buckets: [{ bucketId: "x" }] }] })).toEqual([]);
  });

  test("P-D3: with pools the model buckets become a part of the plan, and stay so when a later call fails", async () => {
    let summaryCalls = 0;
    const provider = geminiSubProvider(
      signedIn(),
      url => {
        if (url.endsWith(":retrieveUserQuotaSummary")) {
          summaryCalls++;
          return summaryCalls === 1 ? Promise.resolve(POOLS) : Promise.reject(new FetchError("rate-limit", "429"));
        }
        return Promise.resolve({ buckets: [{ modelId: "gemini-3-pro", remainingFraction: 0 }] });
      },
      () => Promise.resolve({}),
      () => 0,
      60, // one pool call every 15 rounds
    );
    const first = await provider.fetch();
    expect(first.limits?.map(window => [window.name, window.scoped ?? false])).toEqual([
      ["pool-Gemini_Models-g-5h", false],
      ["pool-Gemini_Models-g-week", false],
      ["gemini-3-pro", true],
    ]);
    // Rounds 2..15 do not ask; round 16 does and fails — the pools stay.
    for (let round = 2; round <= 16; round++) {
      const snapshot = await provider.fetch();
      expect(snapshot.limits?.find(window => window.name === "gemini-3-pro")?.scoped).toBe(true);
    }
    // Round 1 asked once (the first host answered); round 16 asked both hosts, like
    // every Code-Assist call on a failure; the rounds between did not ask at all.
    expect(summaryCalls).toBe(3);
  });

  test("P-D3: without pools the model buckets are the plan", async () => {
    const provider = geminiSubProvider(
      signedIn(),
      url =>
        url.endsWith(":retrieveUserQuotaSummary")
          ? Promise.reject(new FetchError("service", "HTTP 404", { status: 404 }))
          : Promise.resolve({ buckets: [{ modelId: "gemini-3-pro", remainingFraction: 0.2 }] }),
      () => Promise.resolve({}),
      () => 0,
    );
    const snapshot = await provider.fetch();
    expect(snapshot.limits?.map(window => [window.name, window.percent, window.scoped])).toEqual([
      ["gemini-3-pro", 80, undefined],
    ]);
  });
});

describe("names that cannot become an id (D09, 2026-09-25)", () => {
  test("a quota bucket whose model name has no usable character is left out", () => {
    // `sanitizeId("***")` is empty — an object id of "" would land on the account root.
    expect(parseGeminiQuota({ buckets: [{ modelId: "***", remainingFraction: 0.5 }] }).limits).toBeUndefined();
  });

  test("a pool Google reports twice appears once", () => {
    const pools = parseGeminiPools({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.4 },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9 },
          ],
        },
      ],
    });
    expect(pools).toHaveLength(1);
    expect(pools[0].percent).toBe(60);
  });
});

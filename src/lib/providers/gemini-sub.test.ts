import { FetchError, type TokenSet, type TokenStore } from "../provider";
import { buildGeminiAuthorizeUrl, extractGeminiCode, generateGeminiPkce } from "./gemini-auth";
import { GEMINI_IDENTITY, geminiSubProvider, parseCodeAssist, parseGeminiQuota } from "./gemini-sub";

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
    expect(() => extractGeminiCode("http://x/?code=4/abc&state=other", "s1")).toThrow(FetchError);
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
      // Marked as model windows: the fullest one speaks for the account, and the
      // warning names it — not every single model raising its own alarm.
      { name: "gemini-2_5-pro", label: "gemini-2.5-pro", percent: 25, resetAt: "2026-08-27T16:01:15Z", scoped: true },
      { name: "gemini-2_5-flash", label: "gemini-2.5-flash", percent: 80, scoped: true },
    ]);
  });

  test("a bucket without a usable fraction is skipped, not invented as 0 %", () => {
    const snapshot = parseGeminiQuota({ buckets: [{ modelId: "x" }, { modelId: "y", remainingFraction: "nope" }] });
    expect(snapshot.limits).toBeUndefined();
  });

  test("a non-object answer is a network failure", () => {
    expect(() => parseGeminiQuota(42)).toThrow(FetchError);
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
    ).toEqual({ project: "proj-1", tier: "Google AI Ultra" });
  });
});

describe("geminiSubProvider", () => {
  test("both calls carry the identity that decides which buckets Google returns", async () => {
    const calls: { url: string; body: unknown; headers?: Record<string, string> }[] = [];
    const provider = geminiSubProvider(
      memoryStore({ accessToken: "a", refreshToken: "r", expiresAt: 10 * 60_000 }),
      (url, body, headers) => {
        calls.push({ url, body, headers });
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

  test("an account without a project is reported as needing a subscription", async () => {
    const provider = geminiSubProvider(
      memoryStore({ accessToken: "a", refreshToken: "r", expiresAt: 10 * 60_000 }),
      () => Promise.resolve({ ineligibleTiers: [{ reasonCode: "INELIGIBLE_ACCOUNT" }] }),
      () => Promise.resolve({}),
      () => 0,
    );
    await expect(provider.fetch()).rejects.toThrow(/subscription/);
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
    expect(tried).toHaveLength(2);
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

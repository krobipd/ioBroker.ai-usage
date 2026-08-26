import { accountId, clampPollInterval, parseAccounts, sanitizeId, validAccountIds } from "./pure-helpers";

describe("sanitizeId", () => {
  test("keeps safe characters and collapses the rest to single underscores", () => {
    expect(sanitizeId("Claude Max")).toBe("Claude_Max");
    expect(sanitizeId("  weird.name!! ")).toBe("weird_name");
    expect(sanitizeId("a__b")).toBe("a_b");
  });
});

describe("accountId", () => {
  test("a subscription always owns its fixed id, no matter what the row is called", () => {
    expect(accountId("claude-sub", "")).toBe("claude");
    expect(accountId("chatgpt-sub", "")).toBe("chatgpt");
    expect(accountId("gemini-sub", "")).toBe("gemini");
  });

  test("a key-based account always carries the -api suffix, derived from the credential", () => {
    expect(accountId("anthropic-api", "system.credentials.anthropic")).toBe("anthropic-api");
    expect(accountId("openai", "system.credentials.chatgpt")).toBe("chatgpt-api");
  });

  test("the ChatGPT subscription and a stored chatgpt key never collide", () => {
    expect(accountId("chatgpt-sub", "")).not.toBe(accountId("openai", "system.credentials.chatgpt"));
  });

  test("a key-based row without a credential yields no id", () => {
    expect(accountId("openrouter", "")).toBe("");
  });
});

describe("parseAccounts", () => {
  test("accepts valid rows and derives the object id", () => {
    const accounts = parseAccounts([
      { name: "Claude Max", provider: "claude-sub", credentialId: "", warnThreshold: 90, enabled: true },
      { name: "Router", provider: "openrouter", credentialId: "system.credentials.or", enabled: true },
    ]);
    expect(accounts).toEqual([
      { name: "Claude Max", id: "claude", provider: "claude-sub", credentialId: "", warnThreshold: 90 },
      {
        name: "Router",
        id: "or-api",
        provider: "openrouter",
        credentialId: "system.credentials.or",
        warnThreshold: 80,
      },
    ]);
  });

  test("skips disabled rows, unknown providers, credential-less key rows and duplicates", () => {
    const accounts = parseAccounts([
      { name: "Off", provider: "openrouter", credentialId: "system.credentials.off", enabled: false },
      { name: "What", provider: "not-a-provider", credentialId: "system.credentials.x", enabled: true },
      { name: "No credential", provider: "openrouter", credentialId: "", enabled: true },
      { name: "Twice", provider: "openrouter", credentialId: "system.credentials.twice", enabled: true },
      { name: "Twice again", provider: "deepseek", credentialId: "system.credentials.twice", enabled: true },
    ]);
    expect(accounts.map(a => a.id)).toEqual(["twice-api"]);
    expect(accounts[0].provider).toBe("openrouter");
  });

  test("two subscriptions of different kinds live side by side", () => {
    const accounts = parseAccounts([
      { name: "Claude", provider: "claude-sub", credentialId: "", enabled: true },
      { name: "ChatGPT", provider: "chatgpt-sub", credentialId: "", enabled: true },
      { name: "Gemini", provider: "gemini-sub", credentialId: "", enabled: true },
    ]);
    expect(accounts.map(a => a.id)).toEqual(["claude", "chatgpt", "gemini"]);
  });

  test("tolerates a malformed table (API boundary)", () => {
    expect(parseAccounts(undefined)).toEqual([]);
    expect(parseAccounts("nope")).toEqual([]);
    expect(parseAccounts([null, 42, "x"])).toEqual([]);
  });

  test("clamps an out-of-range warn threshold to the default", () => {
    const [account] = parseAccounts([
      { name: "A", provider: "deepseek", credentialId: "system.credentials.a", warnThreshold: 400, enabled: true },
    ]);
    expect(account.warnThreshold).toBe(80);
  });
});

describe("clampPollInterval", () => {
  test("keeps sane values, clamps below 60 and above 3600, defaults garbage to 300", () => {
    expect(clampPollInterval(300)).toBe(300);
    expect(clampPollInterval(10)).toBe(60);
    expect(clampPollInterval(999999)).toBe(3600);
    expect(clampPollInterval("abc")).toBe(300);
    expect(clampPollInterval(undefined)).toBe(300);
  });
});

describe("validAccountIds", () => {
  test("includes disabled rows (paused, not deleted) and skips unusable/duplicate ones", () => {
    expect(
      validAccountIds([
        { name: "Claude Max", provider: "claude-sub", enabled: true },
        { name: "Paused", provider: "openrouter", credentialId: "system.credentials.paused", enabled: false },
        { name: "No credential", provider: "openrouter", credentialId: "" },
        { name: "Claude again", provider: "claude-sub" },
        null,
      ]),
    ).toEqual(["claude", "paused-api"]);
    expect(validAccountIds(undefined)).toEqual([]);
  });
});

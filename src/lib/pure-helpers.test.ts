import { accountId, clampPollInterval, datapointBalanceLine, parseAccounts, sanitizeId } from "./pure-helpers";

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

  test("skips unknown providers, credential-less key rows and duplicates", () => {
    const accounts = parseAccounts([
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

describe("datapointBalanceLine", () => {
  test("stays silent when nothing changed — a normal restart must write nothing", () => {
    expect(datapointBalanceLine(0, 0)).toBeNull();
  });

  test("names only the side that actually happened", () => {
    expect(datapointBalanceLine(4, 0)).toBe("Object tree updated: created 4 datapoint(s)");
    expect(datapointBalanceLine(0, 3)).toBe("Object tree updated: removed 3 datapoint(s)");
  });

  test("reports both sides in one line", () => {
    expect(datapointBalanceLine(12, 3)).toBe("Object tree updated: created 12 datapoint(s), removed 3 datapoint(s)");
  });
});

describe("the admin panel's copy of the id rule", () => {
  test("produces the same id as the adapter, for every shape that matters", async () => {
    // The settings page is its own bundle and carries a second copy of this rule.
    // Nothing forced the two to agree — this does. A drift would move a whole
    // object tree the moment the panel and the adapter disagree on one id.
    const panel = (await import("../../src-admin/src/rows.js")) as { accountId: typeof accountId };
    const cases: [string, string][] = [
      ["claude-sub", ""],
      ["chatgpt-sub", "system.credentials.ignored"],
      ["gemini-sub", ""],
      ["openrouter", "system.credentials.My Router"],
      ["deepseek", "system.credentials.deep_seek"],
      ["openai", "system.credentials.öäü"],
      ["anthropic-api", "system.credentials."],
      ["openrouter", ""],
      ["not-a-provider", "system.credentials.x"],
    ];
    for (const [provider, credentialId] of cases) {
      expect(panel.accountId(provider, credentialId)).toBe(accountId(provider, credentialId));
    }
  });
});

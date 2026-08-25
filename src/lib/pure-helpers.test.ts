import { clampPollInterval, parseAccounts, sanitizeId } from "./pure-helpers";

describe("sanitizeId", () => {
  test("keeps safe characters and collapses the rest to single underscores", () => {
    expect(sanitizeId("Claude Max")).toBe("Claude_Max");
    expect(sanitizeId("  weird.name!! ")).toBe("weird_name");
    expect(sanitizeId("a__b")).toBe("a_b");
  });
});

describe("parseAccounts", () => {
  test("accepts valid rows and derives the object id", () => {
    const accounts = parseAccounts([
      { name: "Claude Max", provider: "claude-sub", credentialId: "", warnThreshold: 90, enabled: true },
      { name: "Router", provider: "openrouter", credentialId: "system.credentials.or", enabled: true },
    ]);
    expect(accounts).toEqual([
      { name: "Claude Max", id: "Claude_Max", provider: "claude-sub", credentialId: "", warnThreshold: 90 },
      {
        name: "Router",
        id: "Router",
        provider: "openrouter",
        credentialId: "system.credentials.or",
        warnThreshold: 80,
      },
    ]);
  });

  test("skips disabled rows, unknown providers, empty names, reserved ids and duplicates", () => {
    const accounts = parseAccounts([
      { name: "Off", provider: "openrouter", enabled: false },
      { name: "What", provider: "gemini", enabled: true },
      { name: "   ", provider: "openrouter", enabled: true },
      { name: "info", provider: "openrouter", enabled: true },
      { name: "total", provider: "openrouter", enabled: true },
      { name: "Twice", provider: "openrouter", enabled: true },
      { name: "Twice", provider: "deepseek", enabled: true },
    ]);
    expect(accounts.map(a => a.id)).toEqual(["Twice"]);
    expect(accounts[0].provider).toBe("openrouter");
  });

  test("tolerates a malformed table (API boundary)", () => {
    expect(parseAccounts(undefined)).toEqual([]);
    expect(parseAccounts("nope")).toEqual([]);
    expect(parseAccounts([null, 42, "x"])).toEqual([]);
  });

  test("clamps an out-of-range warn threshold to the default", () => {
    const [account] = parseAccounts([{ name: "A", provider: "deepseek", warnThreshold: 400, enabled: true }]);
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

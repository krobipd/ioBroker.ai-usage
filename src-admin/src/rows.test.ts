import {
  KEY_PROVIDERS,
  SUBSCRIPTIONS,
  accountId,
  offerForCredential,
  serviceBadge,
  setThreshold,
  subscriptionRow,
  supportedLanguage,
  toggleCredential,
  toggleSubscription,
  type AccountRow,
  type CredentialEntry,
} from "./rows";

/**
 * The config panel is its own bundle and cannot import from the adapter's sources,
 * so `rows.ts` holds a second copy of rules the backend also has. A second copy that
 * nobody tests is a second copy that drifts — these tests pin the half the user sees.
 */

const credential = (over: Partial<CredentialEntry> = {}): CredentialEntry => ({
  id: "system.credentials.MyRouter",
  suffix: "MyRouter",
  name: "My Router",
  ...over,
});

describe("accountId", () => {
  test("a subscription always owns its fixed id", () => {
    expect(accountId("claude-sub", "")).toBe("claude");
    expect(accountId("chatgpt-sub", "")).toBe("chatgpt");
    expect(accountId("gemini-sub", "")).toBe("gemini");
  });

  test("a key account is named after its credential, never after the display name", () => {
    // A rename must not move a whole object tree.
    expect(accountId("openrouter", "system.credentials.MyRouter")).toBe("MyRouter-api");
  });

  test("characters an object id cannot carry are folded away", () => {
    expect(accountId("openrouter", "system.credentials.My Router!")).toBe("My_Router-api");
    expect(accountId("openrouter", "system.credentials.a..b")).toBe("a_b-api");
  });

  test("nothing usable gives an empty id, not a broken one", () => {
    expect(accountId("openrouter", "")).toBe("");
    expect(accountId("openrouter", "system.credentials.___")).toBe("");
  });
});

describe("serviceBadge", () => {
  test("an account that never reported shows nothing rather than a guess", () => {
    expect(serviceBadge(undefined, "")).toBeNull();
    expect(serviceBadge(null, "")).toBeNull();
  });

  test("unreachable is the red case and carries the reason", () => {
    expect(serviceBadge(true, "Not reachable after 3 attempts")).toEqual({
      key: "aiu_stOffline",
      color: "error",
      title: "Not reachable after 3 attempts",
    });
  });

  test("delivering with a reason is amber — a throttle keeps the values valid", () => {
    expect(serviceBadge(false, "Throttled by the provider")).toMatchObject({
      key: "aiu_stLimited",
      color: "warning",
    });
  });

  test("delivering with nothing to report is green and says nothing on hover", () => {
    expect(serviceBadge(false, "")).toEqual({ key: "aiu_stOnline", color: "success", title: "" });
  });

  test("a non-string reason never reaches the tooltip", () => {
    expect(serviceBadge(false, 42)?.color).toBe("success");
  });
});

describe("offerForCredential", () => {
  test("recognises the four key providers by template or display name", () => {
    expect(offerForCredential("openrouter", "")?.provider).toBe("openrouter");
    expect(offerForCredential("", "My Router key")?.provider).toBe("openrouter");
    expect(offerForCredential("deepseek", "")?.provider).toBe("deepseek");
    expect(offerForCredential("openai", "")?.provider).toBe("openai");
    expect(offerForCredential("anthropic", "")?.provider).toBe("anthropic-api");
    expect(offerForCredential("", "Claude key")?.provider).toBe("anthropic-api");
  });

  test("the two org reports are flagged as needing an ADMIN key", () => {
    // A personal key silently returns nothing there — saying so up front is the point.
    expect(offerForCredential("openai", "")?.needsAdminKey).toBe(true);
    expect(offerForCredential("anthropic", "")?.needsAdminKey).toBe(true);
    expect(offerForCredential("deepseek", "")?.needsAdminKey).toBe(false);
    expect(offerForCredential("openrouter", "")?.needsAdminKey).toBe(false);
  });

  test("a plain Gemini key is refused — Google reports no usage for it", () => {
    // The subscription row covers Google; offering the key row would promise data
    // that never arrives.
    expect(offerForCredential("gemini", "Gemini")).toBeNull();
  });

  test("a name that gives nothing away yields no offer", () => {
    expect(offerForCredential("mykey", "Some key")).toBeNull();
  });

  test("every offered provider is one the backend actually knows", () => {
    for (const entry of KEY_PROVIDERS) {
      expect(["openrouter", "deepseek", "openai", "anthropic-api"]).toContain(entry.provider);
    }
    for (const entry of SUBSCRIPTIONS) {
      expect(accountId(entry.provider, "")).not.toBe("");
    }
  });
});

describe("switching rows on and off", () => {
  test("a subscription switch adds exactly one row and removes it again", () => {
    let rows: AccountRow[] = [];
    rows = toggleSubscription(rows, "claude-sub", true, "Claude");
    expect(rows).toEqual([{ name: "Claude", provider: "claude-sub", credentialId: "", warnThreshold: 80 }]);
    // Switching on twice must not duplicate the account.
    rows = toggleSubscription(rows, "claude-sub", true, "Claude");
    expect(rows).toHaveLength(1);
    rows = toggleSubscription(rows, "claude-sub", false, "Claude");
    expect(rows).toEqual([]);
  });

  test("switching a credential on needs a provider, off always works", () => {
    const cred = credential();
    expect(toggleCredential([], cred, "", true)).toEqual([]);
    const rows = toggleCredential([], cred, "openrouter", true);
    expect(rows).toEqual([{ name: "My Router", provider: "openrouter", credentialId: cred.id, warnThreshold: 80 }]);
    expect(toggleCredential(rows, cred, "openrouter", false)).toEqual([]);
  });

  test("other rows survive a switch", () => {
    const rows = toggleSubscription([], "claude-sub", true, "Claude");
    const both = toggleCredential(rows, credential(), "deepseek", true);
    expect(both).toHaveLength(2);
    expect(toggleSubscription(both, "claude-sub", false, "Claude")).toHaveLength(1);
  });

  test("subscriptionRow finds only what is switched on", () => {
    const rows = toggleSubscription([], "claude-sub", true, "Claude");
    expect(subscriptionRow(rows, "claude-sub")?.name).toBe("Claude");
    expect(subscriptionRow(rows, "chatgpt-sub")).toBeUndefined();
  });
});

describe("setThreshold", () => {
  test("clamps to the range the backend accepts", () => {
    const rows = toggleSubscription([], "claude-sub", true, "Claude");
    expect(setThreshold(rows, { provider: "claude-sub" }, "5")[0].warnThreshold).toBe(10);
    expect(setThreshold(rows, { provider: "claude-sub" }, "300")[0].warnThreshold).toBe(100);
    expect(setThreshold(rows, { provider: "claude-sub" }, "55")[0].warnThreshold).toBe(55);
  });

  test("unusable input falls back to the default instead of writing NaN", () => {
    const rows = toggleSubscription([], "claude-sub", true, "Claude");
    expect(setThreshold(rows, { provider: "claude-sub" }, "")[0].warnThreshold).toBe(80);
    expect(setThreshold(rows, { provider: "claude-sub" }, "abc")[0].warnThreshold).toBe(80);
  });

  test("touches only the matched row", () => {
    const rows = toggleCredential(toggleSubscription([], "claude-sub", true, "Claude"), credential(), "deepseek", true);
    const changed = setThreshold(rows, { credentialId: credential().id }, "42");
    expect(changed.find(row => row.provider === "claude-sub")?.warnThreshold).toBe(80);
    expect(changed.find(row => row.provider === "deepseek")?.warnThreshold).toBe(42);
  });
});

describe("supportedLanguage", () => {
  test("takes a shipped language straight through", () => {
    expect(supportedLanguage("de")).toBe("de");
    expect(supportedLanguage("de-DE")).toBe("de");
    expect(supportedLanguage("PT-BR")).toBe("pt");
  });

  test("every Chinese variant maps to the one file we ship", () => {
    expect(supportedLanguage("zh")).toBe("zh-cn");
    expect(supportedLanguage("zh-TW")).toBe("zh-cn");
  });

  test("a language we do not ship falls back to English instead of breaking the panel", () => {
    // The browser can report anything. Before 0.11.0 this went to setLanguage
    // unchecked — it only compiled because a type suppression made the whole
    // expression `any`.
    expect(supportedLanguage("sv-SE")).toBe("en");
    expect(supportedLanguage("cs")).toBe("en");
  });

  test("no language at all is English", () => {
    expect(supportedLanguage(undefined)).toBe("en");
    expect(supportedLanguage("")).toBe("en");
  });

  test("every shipped language survives the round trip", () => {
    for (const lang of ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk"]) {
      expect(supportedLanguage(lang)).toBe(lang);
    }
  });
});

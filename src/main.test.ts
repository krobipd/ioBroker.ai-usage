import { vi } from "vitest";

/** The in-memory file system the token-store tests run against. */
const files = new Map<string, string>();
/** Paths whose read fails with something other than "not there". */
const unreadable = new Set<string>();

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async (path: string) => {
    if (unreadable.has(path)) {
      const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    const content = files.get(path);
    if (content === undefined) {
      const error = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return content;
  }),
  writeFile: vi.fn(async (path: string, content: string) => void files.set(path, content)),
  unlink: vi.fn(async (path: string) => {
    if (!files.delete(path)) {
      throw new Error("ENOENT");
    }
  }),
  rename: vi.fn(async () => {
    throw new Error("ENOENT");
  }),
}));

// Stub the adapter-core base so the adapter can be built without an ioBroker
// runtime. The tests drive its methods directly and assert on these fakes.
vi.mock("@iobroker/adapter-core", () => {
  class Adapter {
    public log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "ai-usage.0";
    public config: Record<string, unknown> = {};
    public on = vi.fn();
    public setState = vi.fn(async () => {});
    public setStateChangedAsync = vi.fn(async () => ({ id: "", notChanged: false }));
    public setInterval = vi.fn(() => ({}) as unknown);
    public clearInterval = vi.fn();
    public setTimeout = vi.fn(() => ({}) as unknown);
    public clearTimeout = vi.fn();
    public sendTo = vi.fn();
    public extendObject = vi.fn(async () => {});
    public getObjectAsync = vi.fn(async () => null);
    public delObjectAsync = vi.fn(async () => {});
    public getAdapterObjectsAsync = vi.fn(async () => ({}));
    public getObjectViewAsync = vi.fn(async () => ({ rows: [] as { id: string }[] }));
    public encrypt = (value: string): string => `enc:${value}`;
    public decrypt = (value: string): string => {
      if (!value.startsWith("enc:")) {
        throw new Error("wrong key");
      }
      return value.slice(4);
    };
    constructor(_opts: unknown) {}
  }
  return {
    Adapter,
    Credentials: { getCredentials: vi.fn(async () => ({ values: { key: "k" } })) },
    getAbsoluteInstanceDataDir: () => "/data/ai-usage.0",
  };
});

import { join } from "node:path";

import { AiUsageAdapter } from "./main";
import type { TokenSet, TokenStore } from "./lib/provider";

/** Typed access to the private members the tests drive. */
interface Internals {
  tokenStore(provider: string): TokenStore;
  signOut(provider: string): Promise<unknown>;
  startSignIn(provider: string): Promise<unknown>;
  submitSignIn(provider: string, message: unknown): Promise<{ status: string; reason?: string }>;
  signInState(provider: string): Promise<{ status: string }>;
  onMessage(obj: unknown): Promise<void>;
  removeRetiredStates(accounts: { id: string }[]): Promise<number>;
  cleanupStaleObjects(): Promise<void>;
  snapshotExistingStates(): Promise<void>;
  knownStateIds: Set<string>;
  attempts: Map<string, unknown>;
  onUnload(cb: () => void): void;
}

const internals = (adapter: AiUsageAdapter): Internals => adapter as unknown as Internals;

// Built the same way the adapter builds it — a hard-coded path with forward
// slashes matches on Linux and macOS and silently misses on Windows.
const CLAUDE_FILE = join("/data/ai-usage.0", "tokens-claude-sub.json");
const tokens: TokenSet = { accessToken: "at", refreshToken: "rt", expiresAt: 9_999_999_999_999 };

function makeAdapter(): AiUsageAdapter {
  files.clear();
  unreadable.clear();
  return new AiUsageAdapter();
}

describe("token store", () => {
  test("one store per provider, so a sign-out really takes effect", async () => {
    const adapter = makeAdapter();
    const store = internals(adapter).tokenStore("claude-sub");
    // Whoever asks gets the SAME store — a second one would carry its own copy of
    // the tokens and keep polling after the sign-out.
    expect(internals(adapter).tokenStore("claude-sub")).toBe(store);

    await store.save(tokens);
    expect(await store.load()).toEqual(tokens);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  test("signing out drops the tokens even after they were read", async () => {
    const adapter = makeAdapter();
    const store = internals(adapter).tokenStore("claude-sub");
    await store.save(tokens);
    await store.load();
    await internals(adapter).signOut("claude-sub");
    expect(await store.load()).toBeNull();
    expect(files.has(CLAUDE_FILE)).toBe(false);
  });

  test("a missing file is silent, an unreadable one is a warning", async () => {
    const adapter = makeAdapter();
    expect(await internals(adapter).tokenStore("claude-sub").load()).toBeNull();
    expect(adapter.log.warn).not.toHaveBeenCalled();

    const second = makeAdapter();
    files.set(CLAUDE_FILE, "this was not written by us");
    expect(await internals(second).tokenStore("claude-sub").load()).toBeNull();
    expect(second.log.warn).toHaveBeenCalledWith(expect.stringContaining("cannot be read"));

    const third = makeAdapter();
    files.set(CLAUDE_FILE, "x");
    unreadable.add(CLAUDE_FILE);
    expect(await internals(third).tokenStore("claude-sub").load()).toBeNull();
    expect(third.log.warn).toHaveBeenCalledWith(expect.stringContaining("cannot open"));
  });

  test("a file without usable tokens counts as not signed in", async () => {
    const adapter = makeAdapter();
    files.set(CLAUDE_FILE, "enc:" + JSON.stringify({ accessToken: "a" }));
    expect(await internals(adapter).tokenStore("claude-sub").load()).toBeNull();
  });
});

describe("sign-in flow", () => {
  test("a paste submitted after the window closed says so instead of failing later", async () => {
    const adapter = makeAdapter();
    await internals(adapter).startSignIn("claude-sub");
    const attempt = internals(adapter).attempts.get("claude-sub") as { expiresAt: number };
    attempt.expiresAt = Date.now() - 1;
    const result = await internals(adapter).submitSignIn("claude-sub", { value: "code" });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("expired");
    // The dead attempt is gone, so the next start begins cleanly.
    expect(internals(adapter).attempts.has("claude-sub")).toBe(false);
  });

  test("submitting without a started sign-in is refused", async () => {
    const adapter = makeAdapter();
    const result = await internals(adapter).submitSignIn("claude-sub", { value: "code" });
    expect(result.status).toBe("failed");
  });

  test("the state of a signed-in subscription comes from the store", async () => {
    const adapter = makeAdapter();
    await internals(adapter).tokenStore("claude-sub").save(tokens);
    expect((await internals(adapter).signInState("claude-sub")).status).toBe("signed-in");
    await internals(adapter).signOut("claude-sub");
    expect((await internals(adapter).signInState("claude-sub")).status).toBe("signed-out");
  });

  test("every message is answered, including an unknown one", async () => {
    const adapter = makeAdapter();
    const answers: unknown[] = [];
    adapter.sendTo = vi.fn((_from: string, _cmd: string, response: unknown) => void answers.push(response));
    await internals(adapter).onMessage({ command: "nonsense", message: {}, from: "x", callback: 1 });
    await internals(adapter).onMessage({ command: "signInStart", message: { provider: "nope" }, from: "x", callback: 1 });
    expect(answers).toHaveLength(2);
    expect(answers.every(a => !!(a as { error?: string }).error)).toBe(true);
  });
});

describe("object housekeeping", () => {
  test("retired status states are only touched when the startup snapshot saw them", async () => {
    const adapter = makeAdapter();
    internals(adapter).knownStateIds = new Set(["claude.info.state", "claude.limits.week.percent"]);
    const removed = await internals(adapter).removeRetiredStates([{ id: "claude" }]);
    expect(removed).toBe(1);
    expect(adapter.delObjectAsync).toHaveBeenCalledTimes(1);
    expect(adapter.delObjectAsync).toHaveBeenCalledWith("claude.info.state");
    // Nothing left to do on the next start — and no lookups either.
    expect(await internals(adapter).removeRetiredStates([{ id: "claude" }])).toBe(0);
    expect(adapter.delObjectAsync).toHaveBeenCalledTimes(1);
  });

  test("an empty account table deletes nothing — the guard against wiping the tree", async () => {
    const adapter = makeAdapter();
    adapter.config = { accounts: [] } as unknown as ioBroker.AdapterConfig;
    adapter.getAdapterObjectsAsync = vi.fn(async () => ({ "ai-usage.0.claude": {} }) as never);
    await internals(adapter).cleanupStaleObjects();
    expect(adapter.delObjectAsync).not.toHaveBeenCalled();
  });

  test("a branch of an account that is no longer in the table goes", async () => {
    const adapter = makeAdapter();
    adapter.config = {
      accounts: [{ name: "Claude", provider: "claude-sub", credentialId: "", warnThreshold: 80 }],
    } as unknown as ioBroker.AdapterConfig;
    adapter.getAdapterObjectsAsync = vi.fn(
      async () =>
        ({
          "ai-usage.0.claude": {},
          "ai-usage.0.claude.info.unreach": {},
          "ai-usage.0.old-api": {},
          "ai-usage.0.info": {},
          "ai-usage.0.total": {},
        }) as never,
    );
    await internals(adapter).cleanupStaleObjects();
    expect(adapter.delObjectAsync).toHaveBeenCalledTimes(1);
    expect(adapter.delObjectAsync).toHaveBeenCalledWith("old-api", { recursive: true });
  });

  test("the startup snapshot records the existing ids without the instance prefix", async () => {
    const adapter = makeAdapter();
    adapter.getObjectViewAsync = vi.fn(async () => ({
      rows: [{ id: "ai-usage.0.claude.warning" }, { id: "ai-usage.0.total.accounts" }],
    })) as unknown as typeof adapter.getObjectViewAsync;
    await internals(adapter).snapshotExistingStates();
    expect([...internals(adapter).knownStateIds]).toEqual(["claude.warning", "total.accounts"]);
  });
});

describe("shutdown", () => {
  test("unload reports the disconnect and returns synchronously", () => {
    const adapter = makeAdapter();
    const done = vi.fn();
    internals(adapter).onUnload(done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(adapter.setState).toHaveBeenCalledWith("info.connection", { val: false, ack: true });
  });
});

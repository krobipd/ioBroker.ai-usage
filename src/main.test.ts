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
    public getForeignObjectAsync = vi.fn(async () => null);
    public extendForeignObjectAsync = vi.fn(async () => ({}));
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

import { readFileSync } from "node:fs";
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
  clearStopInstanceFlag(): Promise<boolean>;
  cleanupStaleObjects(): Promise<void>;
  snapshotExistingStates(): Promise<void>;
  knownStateIds: Set<string>;
  attempts: Map<string, unknown>;
  signInErrors: Map<string, string>;
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

  test("a valid sign-in wins over a remembered failure", async () => {
    // The krobi case (2026-09-01): a stale error from an earlier attempt made the
    // settings row show the sign-in screen although working tokens existed.
    const adapter = makeAdapter();
    await internals(adapter).tokenStore("claude-sub").save(tokens);
    (internals(adapter).signInErrors as Map<string, string>).set("claude-sub", "old failure");
    expect((await internals(adapter).signInState("claude-sub")).status).toBe("signed-in");
    // The stale failure is dropped for good, not just outvoted.
    expect((internals(adapter).signInErrors as Map<string, string>).has("claude-sub")).toBe(false);
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

describe("the leftover stopInstance flag", () => {
  test("a flag still set in the instance object is cleared once", async () => {
    // The entry lives in the manifest AND as a copy in the database; an update merges,
    // it never removes. Without this the whole shutdown path stays dead on every
    // installation that once ran a version carrying it.
    const adapter = makeAdapter();
    adapter.getForeignObjectAsync = vi.fn(async () => ({
      common: { supportedMessages: { stopInstance: true } },
    })) as unknown as typeof adapter.getForeignObjectAsync;
    const extend = vi.fn(async () => ({}));
    adapter.extendForeignObjectAsync = extend as unknown as typeof adapter.extendForeignObjectAsync;

    await internals(adapter).clearStopInstanceFlag();

    expect(extend).toHaveBeenCalledWith("system.adapter.ai-usage.0", {
      common: { supportedMessages: { stopInstance: false } },
    });
    expect(adapter.log.info).toHaveBeenCalledWith(expect.stringContaining("restarts once"));
  });

  test("nothing is written when the flag is already gone", async () => {
    // Otherwise every single start would rewrite the instance object, and every write
    // makes the host restart the instance — a loop.
    const adapter = makeAdapter();
    adapter.getForeignObjectAsync = vi.fn(async () => ({ common: {} })) as unknown as typeof adapter.getForeignObjectAsync;
    const extend = vi.fn(async () => ({}));
    adapter.extendForeignObjectAsync = extend as unknown as typeof adapter.extendForeignObjectAsync;

    await internals(adapter).clearStopInstanceFlag();

    expect(extend).not.toHaveBeenCalled();
    expect(adapter.log.info).not.toHaveBeenCalled();
  });

  test("the startup calls it first and then stops — the restart is coming", async () => {
    // Without the call the correction would ship and change nothing. Without the
    // stop the process would arm its poll timers while the host is already shutting
    // it down — the timer API refuses that and warns in the user's log.
    const adapter = makeAdapter();
    adapter.config = { accounts: [] } as unknown as ioBroker.AdapterConfig;
    const seen: string[] = [];
    adapter.getForeignObjectAsync = vi.fn(async (id: string) => {
      seen.push(id);
      return { common: { supportedMessages: { stopInstance: true } } };
    }) as unknown as typeof adapter.getForeignObjectAsync;
    const extend = vi.fn(async () => ({}));
    adapter.extendForeignObjectAsync = extend as unknown as typeof adapter.extendForeignObjectAsync;

    await (adapter as unknown as { onReady(): Promise<void> }).onReady();

    expect(seen).toContain("system.adapter.ai-usage.0");
    expect(extend).toHaveBeenCalledTimes(1);
    // Nothing else was set up: no object snapshot, no state written.
    expect(adapter.getObjectViewAsync).not.toHaveBeenCalled();
    expect(adapter.setState).not.toHaveBeenCalled();
  });

  test("without a correction the startup carries on as usual", async () => {
    const adapter = makeAdapter();
    adapter.config = { accounts: [] } as unknown as ioBroker.AdapterConfig;
    adapter.getForeignObjectAsync = vi.fn(async () => ({ common: {} })) as unknown as typeof adapter.getForeignObjectAsync;

    await (adapter as unknown as { onReady(): Promise<void> }).onReady();

    expect(adapter.getObjectViewAsync).toHaveBeenCalled();
  });

  test("an unreadable instance object does not stop the startup", async () => {
    const adapter = makeAdapter();
    adapter.getForeignObjectAsync = vi.fn(async () => {
      throw new Error("objects db down");
    }) as unknown as typeof adapter.getForeignObjectAsync;
    // Kein Abbruch des Starts, wenn die Objekt-Datenbank nicht antwortet.
    await expect(internals(adapter).clearStopInstanceFlag()).resolves.toBe(false);
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
  test("the manifest must not declare stopInstance, or none of this runs at all", () => {
    // Measured against the live js-controller 7.2.2 on 2026-08-27: with
    // `supportedMessages.stopInstance` the host sends a message and then kills the
    // process unconditionally (`terminated due to SIGKILL`) — `onUnload` never runs,
    // and every state this adapter writes while shutting down is dead code. Without
    // it the host signals through a state, the adapter ends itself
    // (`ADAPTER_REQUESTED_TERMINATION`) and the writes arrive.
    //
    // This is a property of the MANIFEST, so no amount of shutdown code can defend
    // it — only this test can.
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "io-package.json"), "utf8")) as {
      common: { supportedMessages?: Record<string, unknown> };
    };
    expect(manifest.common.supportedMessages?.stopInstance).toBeUndefined();
  });

  test("the disconnect is written BEFORE the controller is told we are done", async () => {
    // Measured on the live server: writing fire-and-forget and calling back at once
    // means the process is gone before the write lands, and every account keeps
    // claiming to be online while the instance is switched off.
    const adapter = makeAdapter();
    const order: string[] = [];
    // Resolves on a LATER turn of the event loop, like a real database round trip —
    // an `async () => push()` would record the write synchronously and the test
    // would pass even with the callback fired first.
    adapter.setState = vi.fn(
      () =>
        new Promise<string>(resolve =>
          setImmediate(() => {
            order.push("write");
            resolve("");
          }),
        ),
    ) as unknown as typeof adapter.setState;
    const done = vi.fn(() => void order.push("callback"));
    internals(adapter).onUnload(done);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual(["write", "callback"]);
    expect(adapter.setState).toHaveBeenCalledWith("info.connection", { val: false, ack: true });
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("a rejected write still lets the shutdown finish", async () => {
    // The states database going down mid-shutdown must not leave the controller
    // waiting for a callback that never comes.
    const adapter = makeAdapter();
    adapter.setState = vi.fn(() => Promise.reject(new Error("connection closed"))) as unknown as typeof adapter.setState;
    const done = vi.fn();
    internals(adapter).onUnload(done);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(done).toHaveBeenCalledTimes(1);
    expect(adapter.log.debug).toHaveBeenCalledWith(expect.stringContaining("rejected"));
  });
});

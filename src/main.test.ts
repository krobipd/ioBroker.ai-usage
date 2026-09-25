import { vi } from "vitest";

/** The in-memory file system the token-store tests run against. */
const files = new Map<string, string>();
/** The options each write was made with — the file MODE is a rule, not a detail. */
const writeOptions = new Map<string, unknown>();
/** Paths whose read fails with something other than "not there". */
const unreadable = new Set<string>();
/** While set, every write is refused with this message (a full or read-only disk). */
const writeFailure = { message: "" };
/** The access mode per path, as `stat` reports it — set by a write, changed by `chmod`. */
const fileModes = new Map<string, number>();

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(() => Promise.resolve(undefined)),
  readFile: vi.fn((path: string) => {
    if (unreadable.has(path)) {
      const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      return Promise.reject(error);
    }
    const content = files.get(path);
    if (content === undefined) {
      const error = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      return Promise.reject(error);
    }
    return Promise.resolve(content);
  }),
  writeFile: vi.fn((path: string, content: string, options?: unknown) => {
    if (writeFailure.message) {
      return Promise.reject(new Error(writeFailure.message));
    }
    files.set(path, content);
    writeOptions.set(path, options);
    fileModes.set(path, (options as { mode?: number } | undefined)?.mode ?? 0o644);
    return Promise.resolve();
  }),
  rename: vi.fn((from: string, to: string) => {
    const content = files.get(from);
    if (content === undefined) {
      return Promise.reject(new Error("ENOENT"));
    }
    files.delete(from);
    files.set(to, content);
    writeOptions.set(to, writeOptions.get(from));
    writeOptions.delete(from);
    fileModes.set(to, fileModes.get(from) ?? 0o644);
    fileModes.delete(from);
    return Promise.resolve();
  }),
  stat: vi.fn((path: string) =>
    files.has(path)
      ? Promise.resolve({ mode: 0o100000 | (fileModes.get(path) ?? 0o644) })
      : Promise.reject(new Error("ENOENT")),
  ),
  chmod: vi.fn((path: string, mode: number) => {
    fileModes.set(path, mode);
    return Promise.resolve();
  }),
  unlink: vi.fn((path: string) => {
    if (!files.delete(path)) {
      return Promise.reject(new Error("ENOENT"));
    }
    return Promise.resolve();
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
    public setStateChangedAsync = vi.fn(() => Promise.resolve({ id: "", notChanged: false }));
    public setInterval = vi.fn(() => ({}));
    public clearInterval = vi.fn();
    public setTimeout = vi.fn(() => ({}));
    public clearTimeout = vi.fn();
    public sendTo = vi.fn();
    public extendObject = vi.fn(async () => {});
    public getObjectAsync = vi.fn(() => Promise.resolve(null));
    public delObjectAsync = vi.fn(async () => {});
    public getAdapterObjectsAsync = vi.fn(() => Promise.resolve({}));
    public getObjectViewAsync = vi.fn(() => Promise.resolve({ rows: [] as { id: string }[] }));
    public getForeignObjectAsync = vi.fn((id: string) =>
      Promise.resolve(id.startsWith("system.credentials.") ? { _id: id } : null),
    );
    public subscribeForeignObjectsAsync = vi.fn(() => Promise.resolve());
    public unsubscribeForeignObjectsAsync = vi.fn(() => Promise.resolve());
    public getStateAsync = vi.fn(() => Promise.resolve(null));
    public extendForeignObjectAsync = vi.fn(() => Promise.resolve({}));
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
    Credentials: { getCredentials: vi.fn(() => Promise.resolve({ values: { key: "k" } })) },
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
  onMessage(obj: unknown): Promise<void>;
  clearStopInstanceFlag(): Promise<boolean>;
  loadTranslations(): void;
  refreshManifestObjects(): Promise<void>;
  cleanupStaleObjects(accounts: { id: string }[]): Promise<void>;
  removeMovedStates(accounts: { id: string }[]): Promise<void>;
  snapshotExistingStates(): Promise<void>;
  countUpsert(id: string): void;
  logDatapointBalance(): void;
  knownStateIds: Set<string>;
  existingObjectIds: Set<string>;
  makeProvider(
    account: { provider: string; name: string; credentialId: string },
    intervalSec: number,
  ): Promise<{ provider?: { kind: string }; reason?: string }>;
  resolveKey(account: { name: string; credentialId: string }): Promise<{ key?: string; reason?: string }>;
  engine: { deps?: unknown } | null;
  signIn: { state(provider: string): Promise<{ status: string; reason?: string }> };
  onUnload(cb: () => void): void;
  onReady(): Promise<void>;
}

const internals = (adapter: AiUsageAdapter): Internals => adapter as unknown as Internals;

// Built the same way the adapter builds it — a hard-coded path with forward
// slashes matches on Linux and macOS and silently misses on Windows.
const CLAUDE_FILE = join("/data/ai-usage.0", "tokens-claude-sub.json");
const tokens: TokenSet = { accessToken: "at", refreshToken: "rt", expiresAt: 9_999_999_999_999 };

function makeAdapter(): AiUsageAdapter {
  files.clear();
  writeOptions.clear();
  unreadable.clear();
  writeFailure.message = "";
  fileModes.clear();
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

  test("what reaches the disk is ciphertext, never the token itself", async () => {
    // A save() followed by load() proves nothing here: save also fills the in-memory
    // cache, so the reader never touches the file. Only the FILE says whether the
    // encryption actually happened — and it is the whole protection for a refresh
    // token that would otherwise let anyone with read access use the account.
    // (Mutation A9, 2026-09-07: dropping `this.encrypt(...)` survived the entire suite.)
    const adapter = makeAdapter();
    await internals(adapter).tokenStore("claude-sub").save(tokens);
    const written = files.get(CLAUDE_FILE);
    expect(written).toBe(`enc:${JSON.stringify(tokens)}`);
    // …and explicitly NOT the plain payload. (A substring check would be useless
    // here: the fixture's "at" also occurs inside the key name "accessToken".)
    expect(written).not.toBe(JSON.stringify(tokens));
  });

  test("the token file is owner-only", async () => {
    // Encryption and file mode are two independent guards; the adapter key sits on
    // the same machine, so a world-readable ciphertext is not a rest state we want.
    // (Mutation A8, 2026-09-07: 0o600 → 0o644 survived the entire suite.)
    const adapter = makeAdapter();
    await internals(adapter).tokenStore("claude-sub").save(tokens);
    expect(writeOptions.get(CLAUDE_FILE)).toMatchObject({ mode: 0o600 });
  });

  test("clearing drops the tokens even after they were read", async () => {
    // The cache inside the store is the point: a sign-out that only deleted the
    // file left the adapter polling with what it still held in memory.
    const adapter = makeAdapter();
    const store = internals(adapter).tokenStore("claude-sub");
    await store.save(tokens);
    await store.load();
    await store.clear();
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
    files.set(CLAUDE_FILE, `enc:${JSON.stringify({ accessToken: "a" })}`);
    expect(await internals(adapter).tokenStore("claude-sub").load()).toBeNull();
  });

  test("a refresh whose write fails keeps the rotated tokens — the server already rotated", async () => {
    // The refresh happened on the SERVER: by the time the answer is here the old
    // refresh token is spent (decision 3). Taking the new pair only after a
    // successful write meant one full disk cost the sign-in permanently — measured
    // at the real store: ENOSPC on one poll, HTTP 400 on the next.
    const adapter = makeAdapter();
    const store = internals(adapter).tokenStore("claude-sub");
    await store.save(tokens);
    const rotated: TokenSet = { accessToken: "at2", refreshToken: "rt2", expiresAt: 9_999_999_999_999 };
    writeFailure.message = "ENOSPC: no space left on device";
    // Must NOT throw: the caller has nothing better to offer than these tokens.
    await store.replace(tokens, rotated);
    expect(await store.load()).toEqual(rotated);
    expect(adapter.log.warn).toHaveBeenCalledWith(expect.stringContaining("could not be stored"));

    // The disk recovers; the next rotation writes both pairs' worth in one go.
    writeFailure.message = "";
    const again: TokenSet = { accessToken: "at3", refreshToken: "rt3", expiresAt: 9_999_999_999_999 };
    await store.replace(rotated, again);
    expect(files.get(CLAUDE_FILE)).toBe(`enc:${JSON.stringify(again)}`);
    // De-duplicated on the category: the second failure would be debug, not warn.
    expect(adapter.log.warn).toHaveBeenCalledTimes(1);
  });

  test("a sign-out during a refresh is not written back", async () => {
    // `clear()` empties the store and deletes the file. A refresh that was already
    // in flight comes back afterwards — and used to re-create exactly the file the
    // user had just removed (decision 16, the half that was still open).
    const adapter = makeAdapter();
    const store = internals(adapter).tokenStore("claude-sub");
    await store.save(tokens);
    await store.clear();
    await store.replace(tokens, { accessToken: "at2", refreshToken: "rt2", expiresAt: 9_999_999_999_999 });
    expect(await store.load()).toBeNull();
    expect(files.has(CLAUDE_FILE)).toBe(false);
  });

  test("a sign-in that cannot be written still fails loudly", async () => {
    // The other side of the rule: during a sign-in the user is standing in front of
    // the adapter and has to learn that nothing was stored.
    const adapter = makeAdapter();
    writeFailure.message = "EACCES: permission denied";
    await expect(internals(adapter).tokenStore("claude-sub").save(tokens)).rejects.toThrow("EACCES");
  });
});

describe("messages", () => {
  test("the sign-in state of a stored subscription comes through the adapter", async () => {
    // The wiring, not the flow: the manager has its own suite. What is proven
    // here is that the adapter hands it the store it owns.
    const adapter = makeAdapter();
    await internals(adapter).tokenStore("claude-sub").save(tokens);
    expect((await internals(adapter).signIn.state("claude-sub")).status).toBe("signed-in");
  });

  test("every message is answered, including an unknown one", async () => {
    const adapter = makeAdapter();
    const answers: unknown[] = [];
    adapter.sendTo = vi.fn((_from: string, _cmd: string, response: unknown) => void answers.push(response));
    await internals(adapter).onMessage({ command: "nonsense", message: {}, from: "x", callback: 1 });
    await internals(adapter).onMessage({
      command: "signInStart",
      message: { provider: "nope" },
      from: "x",
      callback: 1,
    });
    expect(answers).toHaveLength(2);
    expect(answers.every(a => !!(a as { error?: string }).error)).toBe(true);
  });

  test("a prototype key is not a provider — no sign-in flow starts for it", async () => {
    // The provider tables come out of `Object.fromEntries` and therefore carry
    // Object.prototype: `SIGN_IN_FLOWS["constructor"]` is truthy. The guard tested
    // truthiness, so the word passed, the manager found no matching flow and fell
    // through to the ChatGPT device-code branch — a real request to OpenAI,
    // triggered by a message anyone with messagebox access can send.
    const adapter = makeAdapter();
    const answers: { error?: string }[] = [];
    adapter.sendTo = vi.fn((_from: string, _cmd: string, response: unknown) => void answers.push(response as never));
    for (const provider of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      await internals(adapter).onMessage({ command: "signInStart", message: { provider }, from: "x", callback: 1 });
    }
    expect(answers).toHaveLength(5);
    expect(answers.every(a => !!a.error)).toBe(true);
  });
});

describe("the leftover supportedMessages key", () => {
  test("a flag still set in the instance object is removed, not overwritten", async () => {
    // The entry lives in the manifest AND as a copy in the database; an update merges,
    // it never removes. Without this the whole shutdown path stays dead on every
    // installation that once ran a version carrying it.
    const adapter = makeAdapter();
    adapter.getForeignObjectAsync = vi.fn(() =>
      Promise.resolve({
        common: { supportedMessages: { stopInstance: true } },
      }),
    ) as unknown as typeof adapter.getForeignObjectAsync;
    const extend = vi.fn(() => Promise.resolve({}));
    adapter.extendForeignObjectAsync = extend as unknown as typeof adapter.extendForeignObjectAsync;

    await internals(adapter).clearStopInstanceFlag();

    // `null` DELETES the key. Writing `{ stopInstance: false }` would leave an object
    // behind, and the key is a positive list: an object without a value other than
    // false shuts the message box, so no `sendTo` ever reaches the adapter again.
    expect(extend).toHaveBeenCalledWith("system.adapter.ai-usage.0", {
      common: { supportedMessages: null },
    });
    expect(adapter.log.info).toHaveBeenCalledWith(expect.stringContaining("restarts once"));
  });

  test("the half-correction of 0.9.2 is repaired too", async () => {
    // The live state on krobi's server (2026-09-04): the old code wrote this itself and
    // its guard read `stopInstance`, so it never looked at its own result again. The
    // message box stayed shut for good. The trigger is the KEY, not the value.
    const adapter = makeAdapter();
    adapter.getForeignObjectAsync = vi.fn(() =>
      Promise.resolve({
        common: { supportedMessages: { stopInstance: false } },
      }),
    ) as unknown as typeof adapter.getForeignObjectAsync;
    const extend = vi.fn(() => Promise.resolve({}));
    adapter.extendForeignObjectAsync = extend as unknown as typeof adapter.extendForeignObjectAsync;

    await expect(internals(adapter).clearStopInstanceFlag()).resolves.toBe(true);

    expect(extend).toHaveBeenCalledWith("system.adapter.ai-usage.0", {
      common: { supportedMessages: null },
    });
  });

  test("an empty supportedMessages object is removed as well", async () => {
    // Same class: an object with no entry at all is still an object, and still shuts
    // the message box.
    const adapter = makeAdapter();
    adapter.getForeignObjectAsync = vi.fn(() =>
      Promise.resolve({ common: { supportedMessages: {} } }),
    ) as unknown as typeof adapter.getForeignObjectAsync;
    const extend = vi.fn(() => Promise.resolve({}));
    adapter.extendForeignObjectAsync = extend as unknown as typeof adapter.extendForeignObjectAsync;

    await expect(internals(adapter).clearStopInstanceFlag()).resolves.toBe(true);

    expect(extend).toHaveBeenCalledWith("system.adapter.ai-usage.0", {
      common: { supportedMessages: null },
    });
  });

  test("a list whose only entry is stopInstance loses the whole key", async () => {
    // Removing just the entry would leave an EMPTY positive list — which shuts the
    // message box exactly the same way. This adapter never declares the key at all,
    // so the whole thing goes.
    const adapter = makeAdapter();
    adapter.getForeignObjectAsync = vi.fn(() =>
      Promise.resolve({ common: { supportedMessages: { stopInstance: true } } }),
    ) as unknown as typeof adapter.getForeignObjectAsync;
    const extend = vi.fn(() => Promise.resolve({}));
    adapter.extendForeignObjectAsync = extend as unknown as typeof adapter.extendForeignObjectAsync;

    await expect(internals(adapter).clearStopInstanceFlag()).resolves.toBe(true);

    expect(extend).toHaveBeenCalledWith("system.adapter.ai-usage.0", {
      common: { supportedMessages: null },
    });
  });

  test("nothing is written when the key is already gone", async () => {
    // Otherwise every single start would rewrite the instance object, and every write
    // makes the host restart the instance — a loop.
    const adapter = makeAdapter();
    adapter.getForeignObjectAsync = vi.fn(() =>
      Promise.resolve({
        common: {},
      }),
    ) as unknown as typeof adapter.getForeignObjectAsync;
    const extend = vi.fn(() => Promise.resolve({}));
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
    adapter.getForeignObjectAsync = vi.fn((id: string) => {
      seen.push(id);
      return Promise.resolve({ common: { supportedMessages: { stopInstance: true } } });
    }) as unknown as typeof adapter.getForeignObjectAsync;
    const extend = vi.fn(() => Promise.resolve({}));
    adapter.extendForeignObjectAsync = extend as unknown as typeof adapter.extendForeignObjectAsync;

    await (adapter as unknown as { onReady(): Promise<void> }).onReady();

    expect(seen).toContain("system.adapter.ai-usage.0");
    expect(extend).toHaveBeenCalledTimes(1);
    // Nothing else was set up: no object snapshot, no state written.
    expect(adapter.getAdapterObjectsAsync).not.toHaveBeenCalled();
    expect(adapter.setState).not.toHaveBeenCalled();
  });

  test("a null in the instance object counts as gone", async () => {
    // js-controller stores the deletion as `null`, and that must not read as "the key
    // exists" — otherwise every start would rewrite the object and restart the instance.
    const adapter = makeAdapter();
    adapter.getForeignObjectAsync = vi.fn(() =>
      Promise.resolve({ common: { supportedMessages: null } }),
    ) as unknown as typeof adapter.getForeignObjectAsync;
    const extend = vi.fn(() => Promise.resolve({}));
    adapter.extendForeignObjectAsync = extend as unknown as typeof adapter.extendForeignObjectAsync;

    await expect(internals(adapter).clearStopInstanceFlag()).resolves.toBe(false);

    expect(extend).not.toHaveBeenCalled();
  });

  test("without a correction the startup carries on as usual", async () => {
    const adapter = makeAdapter();
    adapter.config = { accounts: [] } as unknown as ioBroker.AdapterConfig;
    adapter.getForeignObjectAsync = vi.fn(() =>
      Promise.resolve({
        common: {},
      }),
    ) as unknown as typeof adapter.getForeignObjectAsync;

    await (adapter as unknown as { onReady(): Promise<void> }).onReady();

    expect(adapter.getAdapterObjectsAsync).toHaveBeenCalled();
  });

  test("an unreadable instance object does not stop the startup", async () => {
    const adapter = makeAdapter();
    adapter.getForeignObjectAsync = vi.fn(() => {
      return Promise.reject(new Error("objects db down"));
    });
    // Kein Abbruch des Starts, wenn die Objekt-Datenbank nicht antwortet.
    await expect(internals(adapter).clearStopInstanceFlag()).resolves.toBe(false);
  });
});

describe("manifest objects reach an existing installation", () => {
  test("info, info.connection and total are refreshed with their translated texts", async () => {
    // js-controller applies instanceObjects with `preserve` on common.name: without
    // this refresh a renamed object reaches NEW installations only, while every
    // existing tree keeps the old text and the manifest looks correct.
    const adapter = makeAdapter();
    const extended: { id: string; obj: { common?: { name?: unknown; desc?: unknown } } }[] = [];
    adapter.extendObject = vi.fn((id: string, obj: unknown) => {
      extended.push({ id, obj: obj as { common?: { name?: unknown } } });
      return Promise.resolve({});
    }) as unknown as typeof adapter.extendObject;

    internals(adapter).loadTranslations();
    await internals(adapter).refreshManifestObjects();

    expect(extended.map(entry => entry.id)).toEqual(["info", "info.connection", "total"]);
    // Full translation objects, not a resolved language.
    const connection = extended[1].obj.common?.name as Record<string, string>;
    expect(connection.en).toBe("At least one account reachable");
    expect(Object.keys(connection).length).toBe(11);
    // Only the connection has something to explain — the two containers stay empty.
    expect(extended[1].obj.common?.desc).toBeDefined();
    expect(extended[0].obj.common?.desc).toBeUndefined();
    expect(extended[2].obj.common?.desc).toBeUndefined();
  });

  test("a failing refresh never stops the startup", async () => {
    const adapter = makeAdapter();
    adapter.extendObject = vi.fn(() => Promise.reject(new Error("objects db down")));
    await expect(internals(adapter).refreshManifestObjects()).resolves.toBeUndefined();
  });
});

describe("object housekeeping", () => {
  test("an empty account table deletes nothing — the guard against wiping the tree", async () => {
    const adapter = makeAdapter();
    internals(adapter).existingObjectIds = new Set(["claude"]);
    await internals(adapter).cleanupStaleObjects([]);
    expect(adapter.delObjectAsync).not.toHaveBeenCalled();
  });

  test("a state that MOVED in 0.12.0 is deleted at its old id", async () => {
    // `available` went from the account root under `credits`. ioBroker never
    // removes an id an adapter stops writing, so the old one would sit there
    // frozen on its last value.
    const adapter = makeAdapter();
    internals(adapter).knownStateIds = new Set(["deep-api.available", "deep-api.credits.remaining"]);
    await internals(adapter).removeMovedStates([{ id: "deep-api" }]);
    expect(adapter.delObjectAsync).toHaveBeenCalledWith("deep-api.available");
    expect(adapter.delObjectAsync).toHaveBeenCalledTimes(1);
    // Done after the first start — the snapshot no longer holds the id.
    await internals(adapter).removeMovedStates([{ id: "deep-api" }]);
    expect(adapter.delObjectAsync).toHaveBeenCalledTimes(1);
  });

  test("a branch of an account that is no longer in the table goes", async () => {
    const adapter = makeAdapter();
    internals(adapter).existingObjectIds = new Set(["claude", "claude.info.unreach", "old-api", "info", "total"]);
    await internals(adapter).cleanupStaleObjects([{ id: "claude" }]);
    expect(adapter.delObjectAsync).toHaveBeenCalledTimes(1);
    expect(adapter.delObjectAsync).toHaveBeenCalledWith("old-api", { recursive: true });
  });

  test("a plain restart reports NOTHING — the whole point of the startup snapshot", async () => {
    // The create path runs extendObject over EVERY state once per process, also over
    // states that were already there. Counting "the create path touched it" would
    // report the entire tree as new after every restart and turn the line into noise.
    const adapter = makeAdapter();
    adapter.getAdapterObjectsAsync = vi.fn(() =>
      Promise.resolve({
        "ai-usage.0.claude.warning": { type: "state" },
        "ai-usage.0.claude.limits.week.percent": { type: "state" },
      } as never),
    );
    await internals(adapter).snapshotExistingStates();

    // The engine upserts both existing states again, as it does on every start.
    for (const id of ["claude.warning", "claude.limits.week.percent"]) {
      internals(adapter).countUpsert(id);
    }
    internals(adapter).logDatapointBalance();
    expect(adapter.log.info).not.toHaveBeenCalled();
  });

  test("only what the snapshot did not hold counts as new", async () => {
    const adapter = makeAdapter();
    adapter.getAdapterObjectsAsync = vi.fn(() =>
      Promise.resolve({ "ai-usage.0.claude.warning": { type: "state" } } as never),
    );
    await internals(adapter).snapshotExistingStates();

    internals(adapter).countUpsert("claude.warning"); // already there
    internals(adapter).countUpsert("claude.limits.session.percent"); // new
    internals(adapter).countUpsert("claude.limits.session.resetAt"); // new
    internals(adapter).logDatapointBalance();

    expect(adapter.log.info).toHaveBeenCalledWith("Object tree updated: created 2 datapoint(s)");
  });

  test("the balance is written once, not once per account", async () => {
    const adapter = makeAdapter();
    adapter.getAdapterObjectsAsync = vi.fn(() => Promise.resolve({} as never));
    await internals(adapter).snapshotExistingStates();
    internals(adapter).countUpsert("claude.warning");
    internals(adapter).logDatapointBalance();
    internals(adapter).logDatapointBalance();
    expect(adapter.log.info).toHaveBeenCalledTimes(1);
  });

  test("the startup snapshot records the existing ids without the instance prefix", async () => {
    const adapter = makeAdapter();
    adapter.getAdapterObjectsAsync = vi.fn(() =>
      Promise.resolve({
        "ai-usage.0.claude": { type: "device" },
        "ai-usage.0.claude.warning": { type: "state" },
        "ai-usage.0.total.accounts": { type: "state" },
      } as never),
    );
    await internals(adapter).snapshotExistingStates();
    // Only the STATES count towards the datapoint balance…
    expect([...internals(adapter).knownStateIds]).toEqual(["claude.warning", "total.accounts"]);
    // …while the cleanup needs the parents too — one read for both.
    expect([...internals(adapter).existingObjectIds]).toEqual(["claude", "claude.warning", "total.accounts"]);
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
    adapter.setStateChangedAsync = vi.fn(
      () =>
        new Promise<string>(resolve =>
          setImmediate(() => {
            order.push("write");
            resolve("");
          }),
        ),
    );
    const done = vi.fn(() => void order.push("callback"));
    internals(adapter).onUnload(done);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual(["write", "callback"]);
    // The comparing write, like every other `info.connection` write of this adapter
    // (decision 13) — the two paths in main.ts used the plain one.
    expect(adapter.setStateChangedAsync).toHaveBeenCalledWith("info.connection", { val: false, ack: true });
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("a rejected write still lets the shutdown finish", async () => {
    // The states database going down mid-shutdown must not leave the controller
    // waiting for a callback that never comes.
    const adapter = makeAdapter();
    // The method the shutdown actually calls — the harness stubs it to RESOLVE, so
    // rejecting `setState` instead would have left this test green and blind.
    adapter.setStateChangedAsync = vi.fn(() => Promise.reject(new Error("connection closed")));
    const done = vi.fn();
    internals(adapter).onUnload(done);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(done).toHaveBeenCalledTimes(1);
    expect(adapter.log.debug).toHaveBeenCalledWith(expect.stringContaining("rejected"));
  });
});

describe("building a provider for every account kind", () => {
  // Seven kinds, one contract. The wiring itself had no test: a kind that fell out
  // of the switch would simply leave its account unpolled, and the skeleton around
  // it still looks healthy.
  const kinds = [
    "claude-sub",
    "chatgpt-sub",
    "gemini-sub",
    "openrouter",
    "deepseek",
    "openai",
    "anthropic-api",
  ] as const;

  for (const kind of kinds) {
    test(`${kind} gets a provider of its own kind`, async () => {
      const adapter = makeAdapter();
      const provider = await internals(adapter).makeProvider(
        { provider: kind, name: kind, credentialId: "system.credentials.x" },
        300,
      );
      expect(provider.provider?.kind).toBe(kind);
    });
  }
});

describe("resolving a stored key", () => {
  test("no credential picked: the account stays unpolled and the reason is named", async () => {
    const adapter = makeAdapter();
    const resolved = await internals(adapter).resolveKey({ name: "Router", credentialId: "" });
    expect(resolved.key).toBeUndefined();
    expect(resolved.reason).toContain("No API key selected");
    expect(adapter.log.warn).toHaveBeenCalledWith(expect.stringContaining("no credential selected"));
  });

  test("a credential without a key is named too, not silently skipped", async () => {
    const adapter = makeAdapter();
    const core = (await import("@iobroker/adapter-core")) as unknown as {
      Credentials: { getCredentials: ReturnType<typeof vi.fn> };
    };
    core.Credentials.getCredentials = vi.fn(() => Promise.resolve({ values: {} }));
    const resolved = await internals(adapter).resolveKey({ name: "Router", credentialId: "system.credentials.or" });
    expect(resolved.key).toBeUndefined();
    // `info.error` names THIS reason, not "no key selected" (decision 73).
    expect(resolved.reason).toContain("carries no API key");
    expect(adapter.log.warn).toHaveBeenCalledWith(expect.stringContaining("carries no API key"));
  });

  test("an unreadable credential does not take the startup down", async () => {
    const adapter = makeAdapter();
    const core = (await import("@iobroker/adapter-core")) as unknown as {
      Credentials: { getCredentials: ReturnType<typeof vi.fn> };
    };
    core.Credentials.getCredentials = vi.fn(() => Promise.reject(new Error("storage locked")));
    const resolved = await internals(adapter).resolveKey({ name: "Router", credentialId: "system.credentials.or" });
    expect(resolved.key).toBeUndefined();
    expect(resolved.reason).toContain("storage locked");
    expect(adapter.log.warn).toHaveBeenCalledWith(expect.stringContaining("storage locked"));
    core.Credentials.getCredentials = vi.fn(() => Promise.resolve({ values: { key: "k" } }));
  });

  test("a usable credential comes back as the key itself", async () => {
    const adapter = makeAdapter();
    const resolved = await internals(adapter).resolveKey({ name: "Router", credentialId: "system.credentials.or" });
    expect(resolved.key).toBe("k");
  });

  test("a selected key that no longer exists is named as exactly that", async () => {
    const adapter = makeAdapter();
    adapter.getForeignObjectAsync = vi.fn(() => Promise.resolve(null));
    const resolved = await internals(adapter).resolveKey({ name: "Router", credentialId: "system.credentials.or" });
    expect(resolved.key).toBeUndefined();
    expect(resolved.reason).toContain("no longer exists");
  });
});

describe("discarded account rows reach the log", () => {
  test("a row the parser cannot use is named at startup", async () => {
    const adapter = makeAdapter();
    adapter.config = {
      accounts: [
        { name: "Good", provider: "openrouter", credentialId: "system.credentials.or", warnThreshold: 80 },
        { name: "Broken", provider: "not-a-provider", credentialId: "system.credentials.x", warnThreshold: 80 },
      ],
      pollInterval: 300,
      notifications: true,
    };
    await (adapter as unknown as { onReady(): Promise<void> }).onReady();
    expect(adapter.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Account row "Broken" is not being monitored'),
    );
    internals(adapter).onUnload(() => undefined);
  });

  test("the notification seam is wired only when the user asked for notifications", async () => {
    // `notify` is optional on purpose: switched off, the engine must not even be
    // handed a callback, or a threshold crossing would still reach the user.
    // WITH an account: without one `onReady` returns before an engine exists, so
    // the "switched on" half was never actually exercised.
    const withNotifications = makeAdapter();
    withNotifications.config = {
      accounts: [{ name: "Router", provider: "openrouter", credentialId: "system.credentials.or", warnThreshold: 80 }],
      pollInterval: 300,
      notifications: true,
    };
    await (withNotifications as unknown as { onReady(): Promise<void> }).onReady();

    const adapter = makeAdapter();
    adapter.config = {
      accounts: [{ name: "Router", provider: "openrouter", credentialId: "system.credentials.or", warnThreshold: 80 }],
      pollInterval: 300,
      notifications: false,
    };
    await (adapter as unknown as { onReady(): Promise<void> }).onReady();
    const deps = (internals(adapter).engine as unknown as { deps: { notify?: unknown } }).deps;
    expect(deps.notify).toBeUndefined();
    internals(adapter).onUnload(() => undefined);

    // The other half, which the test never made: switched ON, the seam must
    // actually be there. Asserting only the absence let a wiring that never
    // provides it pass.
    const wired = (internals(withNotifications).engine as unknown as { deps: { notify?: unknown } }).deps;
    expect(typeof wired.notify).toBe("function");
    internals(withNotifications).onUnload(() => undefined);
  });
});

describe("a shutdown that lands inside the startup", () => {
  test("the startup stops instead of deleting and starting up after the host was told we are done", async () => {
    // Decisions 32/47 guard every `await` of the POLL path — the startup path had
    // no such check, because `stop()` can only reach an engine that already exists.
    // A shutdown during the startup's own database waits therefore let `onReady`
    // run on: it deleted stale objects after the host had been told the adapter was
    // finished, and started an engine nobody would stop.
    const adapter = makeAdapter();
    adapter.config = {
      accounts: [{ name: "OR", provider: "openrouter", credentialId: "system.credentials.or", warnThreshold: 80 }],
      pollInterval: 300,
    } as unknown as ioBroker.AdapterConfig;
    // The host asks us to stop while the startup snapshot is being read — and the
    // snapshot hands back an object the cleanup WOULD delete, so this test can only
    // pass because the guard ran, not because there was nothing to do.
    adapter.getAdapterObjectsAsync = vi.fn(() => {
      internals(adapter).onUnload(() => {});
      return Promise.resolve({ "ai-usage.0.old-api": { type: "state" } });
    }) as unknown as typeof adapter.getAdapterObjectsAsync;

    await internals(adapter).onReady();

    expect(adapter.delObjectAsync).not.toHaveBeenCalled();
    expect(internals(adapter).engine).toBeNull();
  });

  test("without the shutdown the same startup does delete and does start", async () => {
    // The counter-test: the guard must stop a SHUTDOWN, not the startup itself.
    const adapter = makeAdapter();
    adapter.config = {
      accounts: [{ name: "OR", provider: "openrouter", credentialId: "system.credentials.or", warnThreshold: 80 }],
      pollInterval: 300,
    } as unknown as ioBroker.AdapterConfig;
    adapter.getAdapterObjectsAsync = vi.fn(() =>
      Promise.resolve({ "ai-usage.0.old-api": { type: "state" } }),
    ) as unknown as typeof adapter.getAdapterObjectsAsync;

    await internals(adapter).onReady();

    expect(adapter.delObjectAsync).toHaveBeenCalledWith("old-api", { recursive: true });
    expect(internals(adapter).engine).not.toBeNull();
  });
});

/** Loose access to what the adapter hands its collaborators, for the wiring tests. */
interface Wiring {
  signIn: {
    deps: { onSignedIn(provider: string): void; onSignedOut(provider: string): void };
    state(provider: string): Promise<{ status: string; reason?: string }>;
  };
  engine: {
    pollNow: (id: string) => Promise<void>;
    setProvider?: (id: string, provider: unknown, reason?: string) => Promise<void>;
    deps?: {
      authState?(id: string, rejected: boolean): void;
      deleteObject(id: string): Promise<void>;
      listStateIds(prefix: string): Promise<string[]>;
      readState(id: string): Promise<unknown>;
    };
  } | null;
  onObjectChange(id: string, obj: unknown): Promise<void>;
  watchedCredentials: Map<string, unknown>;
  removedStates: number;
}

const wiring = (adapter: AiUsageAdapter): Wiring => adapter as unknown as Wiring;

/** A key account row, as the settings page stores it. */
const KEY_ROW = { name: "Router", provider: "openrouter", credentialId: "system.credentials.or", warnThreshold: 80 };

describe("audit 2026-09-25 — the adapter layer", () => {
  test("R21: one account's action-required message cannot push out another's", () => {
    // js-controller 7.2.2 (`notificationHandler.ts`) keeps at most `limit` messages per
    // instance and category and drops the oldest. With 1, the second account's
    // rejected sign-in erased the first account's — ten covers a usual setup.
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "io-package.json"), "utf8")) as {
      notifications: { categories: { limit: number }[] }[];
    };
    expect(manifest.notifications[0].categories[0].limit).toBe(10);
  });

  test("K9: a key account names the adapter in the User-Agent of its request", async () => {
    const adapter = makeAdapter();
    const agents: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        agents.push(new Headers(init.headers).get("user-agent"));
        return Promise.resolve(
          new Response(JSON.stringify({ data: { usage: 1 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );
    try {
      const built = await internals(adapter).makeProvider(
        { provider: "openrouter", name: "Router", credentialId: "system.credentials.or" },
        300,
      );
      await (built.provider as unknown as { fetch(): Promise<unknown> }).fetch();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatch(/^ioBroker\.ai-usage\//);
  });

  test("F6: with no account, the totals are zeroed and the trees the guard keeps lose their alarms", async () => {
    const adapter = makeAdapter();
    adapter.config = { accounts: [] } as unknown as ioBroker.AdapterConfig;
    adapter.getAdapterObjectsAsync = vi.fn(() =>
      Promise.resolve({
        "ai-usage.0.claude": { type: "device" },
        "ai-usage.0.claude.warning": { type: "state" },
        "ai-usage.0.claude.limitReached": { type: "state" },
        "ai-usage.0.claude.info.unreach": { type: "state" },
        "ai-usage.0.claude.info.error": { type: "state" },
      }),
    ) as unknown as typeof adapter.getAdapterObjectsAsync;
    await internals(adapter).onReady();
    const written = (adapter.setStateChangedAsync as unknown as { mock: { calls: [string, { val: unknown }][] } }).mock
      .calls;
    const value = (id: string): unknown => written.filter(call => call[0] === id).at(-1)?.[1].val;
    expect(value("claude.warning")).toBe(false);
    expect(value("claude.limitReached")).toBe(false);
    expect(value("claude.info.unreach")).toBe(true);
    expect(value("claude.info.error")).toBe("Unknown");
    expect(value("total.limitReached")).toBe(false);
    expect(value("total.accounts")).toBe(0);
    // Nothing deleted: the empty-table guard stays.
    expect(adapter.delObjectAsync).not.toHaveBeenCalled();
    internals(adapter).onUnload(() => undefined);
  });

  test("F13: a sign-out whose token file cannot be deleted is not silent", async () => {
    const adapter = makeAdapter();
    const store = internals(adapter).tokenStore("claude-sub");
    await store.save(tokens);
    const fs = await import("node:fs/promises");
    vi.mocked(fs.unlink).mockImplementationOnce(() => {
      const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      return Promise.reject(error);
    });
    await expect(store.clear()).rejects.toThrow("EACCES");
    expect(adapter.log.warn).toHaveBeenCalledWith(expect.stringContaining("could not be deleted"));
    // In memory the sign-out took effect regardless.
    expect(await store.load()).toBeNull();
  });

  test("R10: a token file is written beside and then renamed — a failed write leaves the old one intact", async () => {
    const adapter = makeAdapter();
    const store = internals(adapter).tokenStore("claude-sub");
    await store.save(tokens);
    const fs = await import("node:fs/promises");
    expect(fs.rename).toHaveBeenCalledWith(`${CLAUDE_FILE}.tmp`, CLAUDE_FILE);
    writeFailure.message = "ENOSPC: no space left on device";
    await store.replace(tokens, { accessToken: "at2", refreshToken: "rt2", expiresAt: 9_999_999_999_999 });
    expect(files.get(CLAUDE_FILE)).toBe(`enc:${JSON.stringify(tokens)}`);
  });

  test("R10: a token file others may read is narrowed to owner-only when it is loaded", async () => {
    const adapter = makeAdapter();
    files.set(CLAUDE_FILE, `enc:${JSON.stringify(tokens)}`);
    fileModes.set(CLAUDE_FILE, 0o644);
    expect(await internals(adapter).tokenStore("claude-sub").load()).toEqual(tokens);
    expect(fileModes.get(CLAUDE_FILE)).toBe(0o600);
  });

  test("R4: a deletion the database refuses reaches the engine instead of being swallowed", async () => {
    const adapter = makeAdapter();
    adapter.config = { accounts: [KEY_ROW], pollInterval: 300 } as unknown as ioBroker.AdapterConfig;
    await internals(adapter).onReady();
    adapter.delObjectAsync = vi.fn(() => Promise.reject(new Error("db down")));
    await expect(wiring(adapter).engine?.deps?.deleteObject("or-api.limits.x")).rejects.toThrow("db down");
    internals(adapter).onUnload(() => undefined);
  });

  test("R5: one stale account that cannot be removed does not keep the others, and is not counted", async () => {
    const adapter = makeAdapter();
    internals(adapter).existingObjectIds = new Set(["old1.x", "old2.y"]);
    internals(adapter).knownStateIds = new Set(["old1.x", "old2.y"]);
    const attempts: string[] = [];
    adapter.delObjectAsync = vi.fn((id: string) => {
      attempts.push(id);
      return id === "old1" ? Promise.reject(new Error("db")) : Promise.resolve();
    });
    await internals(adapter).cleanupStaleObjects([{ id: "keep" }]);
    expect(attempts).toEqual(["old1", "old2"]);
    expect(wiring(adapter).removedStates).toBe(1);
  });

  test("F11/decision 9: sign-in and sign-out both make the engine ask at once — the account's own id", () => {
    const adapter = makeAdapter();
    const pollNow = vi.fn(() => Promise.resolve());
    wiring(adapter).engine = { pollNow };
    wiring(adapter).signIn.deps.onSignedIn("claude-sub");
    wiring(adapter).signIn.deps.onSignedOut("chatgpt-sub");
    expect(pollNow.mock.calls).toEqual([["claude"], ["chatgpt"]]);
  });

  test("decision 28: a rejection the engine reports reaches the settings card", async () => {
    const adapter = makeAdapter();
    adapter.config = {
      accounts: [{ name: "Claude", provider: "claude-sub", credentialId: "", warnThreshold: 80 }],
      pollInterval: 300,
    } as unknown as ioBroker.AdapterConfig;
    await internals(adapter).onReady();
    await internals(adapter).tokenStore("claude-sub").save(tokens);
    wiring(adapter).engine?.deps?.authState?.("claude", true);
    expect((await wiring(adapter).signIn.state("claude-sub")).status).toBe("failed");
    wiring(adapter).engine?.deps?.authState?.("claude", false);
    expect((await wiring(adapter).signIn.state("claude-sub")).status).toBe("signed-in");
    internals(adapter).onUnload(() => undefined);
  });

  test("a sign-in message for a real provider reaches the manager, and a failure is still answered", async () => {
    const adapter = makeAdapter();
    const answers: unknown[] = [];
    adapter.sendTo = vi.fn((_from: string, _cmd: string, response: unknown) => void answers.push(response));
    await internals(adapter).onMessage({
      command: "signInStart",
      message: { provider: "claude-sub" },
      from: "x",
      callback: 1,
    });
    expect(answers[0]).toMatchObject({ status: "awaiting-paste" });
    wiring(adapter).signIn.state = () => Promise.reject(new Error("boom"));
    await internals(adapter).onMessage({
      command: "signInStatus",
      message: { provider: "claude-sub" },
      from: "x",
      callback: 1,
    });
    expect(answers[1]).toEqual({ error: "internal error — see log" });
  });

  test("the state view of an account ends at its own dot — foo-api never lists foo-api2-api", async () => {
    const adapter = makeAdapter();
    adapter.config = { accounts: [KEY_ROW], pollInterval: 300 } as unknown as ioBroker.AdapterConfig;
    await internals(adapter).onReady();
    await wiring(adapter).engine?.deps?.listStateIds("foo-api");
    expect(adapter.getObjectViewAsync).toHaveBeenCalledWith("system", "state", {
      startkey: "ai-usage.0.foo-api.",
      endkey: "ai-usage.0.foo-api.￿",
    });
    internals(adapter).onUnload(() => undefined);
  });

  test("decision 50 at the adapter: the previous warning is read back from the database", async () => {
    const adapter = makeAdapter();
    adapter.getStateAsync = vi.fn(() => Promise.resolve({ val: true })) as never;
    adapter.config = { accounts: [KEY_ROW], pollInterval: 300 } as unknown as ioBroker.AdapterConfig;
    await internals(adapter).onReady();
    expect(await wiring(adapter).engine?.deps?.readState("or-api.warning")).toBe(true);
    expect(adapter.getStateAsync).toHaveBeenCalledWith("or-api.warning");
    internals(adapter).onUnload(() => undefined);
  });

  test("R15: the key accounts' credentials are followed, and a change swaps the key in place", async () => {
    const adapter = makeAdapter();
    adapter.config = { accounts: [KEY_ROW], pollInterval: 300 } as unknown as ioBroker.AdapterConfig;
    await internals(adapter).onReady();
    expect(adapter.subscribeForeignObjectsAsync).toHaveBeenCalledWith("system.credentials.or");
    const setProvider = vi.fn(() => Promise.resolve());
    (wiring(adapter).engine as { setProvider?: unknown }).setProvider = setProvider;
    const core = (await import("@iobroker/adapter-core")) as unknown as {
      Credentials: { getCredentials: ReturnType<typeof vi.fn> };
    };
    // Same key re-saved: nothing to do.
    await wiring(adapter).onObjectChange("system.credentials.or", { _id: "system.credentials.or" });
    expect(setProvider).not.toHaveBeenCalled();
    // A new key: the account's provider is replaced.
    core.Credentials.getCredentials = vi.fn(() => Promise.resolve({ values: { key: "k2" } }));
    await wiring(adapter).onObjectChange("system.credentials.or", { _id: "system.credentials.or" });
    expect(setProvider).toHaveBeenCalledWith("or-api", expect.objectContaining({ kind: "openrouter" }));
    // Deleted: the account is no longer watched, with the reason.
    await wiring(adapter).onObjectChange("system.credentials.or", null);
    expect(setProvider).toHaveBeenLastCalledWith("or-api", null, expect.stringContaining("no longer exists"));
    core.Credentials.getCredentials = vi.fn(() => Promise.resolve({ values: { key: "k" } }));
    // The subscriptions end with the instance.
    internals(adapter).onUnload(() => undefined);
    expect(adapter.unsubscribeForeignObjectsAsync).toHaveBeenCalledWith("system.credentials.or");
  });

  // Each guard of the startup is checked on its own: the NEXT step must not run. The
  // guards are redundant in effect (a later one would still stop the engine), so a
  // test that only asked for "no engine" let any single guard disappear unnoticed.
  for (const [stage, next, label] of [
    ["refreshManifestObjects", "snapshotExistingStates", "after the manifest refresh"],
    ["removeMovedStates", "makeProvider", "after the cleanup"],
    ["makeProvider", "watchCredentials", "after the providers were built"],
  ] as const) {
    test(`a shutdown ${label} stops the startup there`, async () => {
      const adapter = makeAdapter();
      adapter.config = { accounts: [KEY_ROW], pollInterval: 300 } as unknown as ioBroker.AdapterConfig;
      const target = internals(adapter) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = target[stage].bind(adapter);
      target[stage] = async (...args: unknown[]) => {
        const result = await original(...args);
        internals(adapter).onUnload(() => undefined);
        return result;
      };
      const reached = vi.fn();
      const follow = target[next].bind(adapter);
      target[next] = (...args: unknown[]) => {
        reached();
        return follow(...args);
      };
      await internals(adapter).onReady();
      expect(reached).not.toHaveBeenCalled();
      expect(internals(adapter).engine).toBeNull();
    });
  }

  test("a shutdown while the engine starts stops the startup before the credentials are followed", async () => {
    const adapter = makeAdapter();
    adapter.config = { accounts: [KEY_ROW], pollInterval: 300 } as unknown as ioBroker.AdapterConfig;
    // The account's first skeleton object — inside `engine.start()`, not the
    // manifest refresh before it.
    adapter.extendObject = vi.fn((id: string) => {
      if (id === "or-api") {
        internals(adapter).onUnload(() => undefined);
      }
      return Promise.resolve();
    }) as never;
    await internals(adapter).onReady();
    expect(adapter.subscribeForeignObjectsAsync).not.toHaveBeenCalled();
  });

  test("N1: the reason the adapter found for a missing key is what info.error says", async () => {
    const adapter = makeAdapter();
    adapter.getForeignObjectAsync = vi.fn(() => Promise.resolve(null));
    adapter.config = { accounts: [KEY_ROW], pollInterval: 300 } as unknown as ioBroker.AdapterConfig;
    await internals(adapter).onReady();
    expect(adapter.setStateChangedAsync).toHaveBeenCalledWith("or-api.info.error", {
      val: expect.stringContaining("no longer exists"),
      ack: true,
    });
    internals(adapter).onUnload(() => undefined);
  });

  test("the shutdown waits for the offline stamp before it calls back", async () => {
    const adapter = makeAdapter();
    const order: string[] = [];
    let release: () => void = () => undefined;
    wiring(adapter).engine = {
      pollNow: () => Promise.resolve(),
      stop: () => undefined,
      markAllOffline: () =>
        new Promise<void>(resolve => {
          release = () => {
            order.push("offline");
            resolve();
          };
        }),
    } as never;
    internals(adapter).onUnload(() => void order.push("callback"));
    await new Promise(resolve => setImmediate(resolve));
    expect(order).toEqual([]);
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(order).toEqual(["offline", "callback"]);
  });
});

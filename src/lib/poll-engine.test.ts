import { PollEngine, type EngineDeps } from "./poll-engine";
import type { ObjectDef } from "./snapshot-tree";
import type { AccountConfig } from "./pure-helpers";
import { FetchError, type UsageProvider, type UsageSnapshot } from "./provider";

/**
 * A scripted provider: shift one result per fetch (value = snapshot, function = thrower).
 *
 * @param script Results handed out one per fetch: a snapshot, or a function that throws
 */
function scriptedProvider(script: (UsageSnapshot | (() => never))[]): UsageProvider & { fetches: number } {
  const provider = {
    kind: "openrouter" as const,
    fetches: 0,
    fetch(): Promise<UsageSnapshot> {
      provider.fetches++;
      const next = script.shift();
      if (!next) {
        throw new Error("script exhausted");
      }
      if (typeof next === "function") {
        next();
      }
      return Promise.resolve(next as UsageSnapshot);
    },
  };
  return provider;
}

interface Harness {
  deps: EngineDeps;
  states: Map<string, boolean | number | string>;
  /** Ids written through the changed-write seam (indicators). */
  changedWrites: string[];
  objects: string[];
  /** Object ids the engine deleted. */
  deleted: string[];
  /** What `listStateIds` hands back — the database as the test wants to stage it. */
  existing: string[];
  /** The full definition per upserted id — for assertions on `common`. */
  upserted: Map<string, ObjectDef>;
  notifications: string[];
  /** Every `authState` callback the engine fired, in order. */
  authStates: { accountId: string; rejected: boolean }[];
  /** How many repeating timers are armed right now. */
  intervalCount(): number;
  /** Fire every scheduled one-shot immediately queued and each interval once. */
  tick(): Promise<void>;
  clock: { now: number };
}

function makeHarness(): Harness {
  const states = new Map<string, boolean | number | string>();
  const changedWrites: string[] = [];
  const objects: string[] = [];
  const deleted: string[] = [];
  const existing: string[] = [];
  const upserted = new Map<string, ObjectDef>();
  const notifications: string[] = [];
  const authStates: { accountId: string; rejected: boolean }[] = [];
  const pending: (() => void)[] = [];
  const intervals: (() => void)[] = [];
  const clock = { now: 1_000_000 };
  const deps: EngineDeps = {
    upsertObject: def => {
      objects.push(def.id);
      upserted.set(def.id, def);
      return Promise.resolve();
    },
    deleteObject: id => {
      deleted.push(id);
      return Promise.resolve();
    },
    listStateIds: () => Promise.resolve([...existing]),
    setState: (id, value) => void states.set(id, value),
    setStateChanged: (id, value) => {
      changedWrites.push(id);
      states.set(id, value);
      return Promise.resolve();
    },
    schedule: cb => {
      intervals.push(cb);
      return cb;
    },
    scheduleOnce: cb => {
      pending.push(cb);
      return cb;
    },
    cancel: () => undefined,
    now: () => clock.now,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    notify: (_account, message) => void notifications.push(message),
    authState: (accountId, rejected) => void authStates.push({ accountId, rejected }),
  };
  return {
    deps,
    states,
    deleted,
    existing,
    changedWrites,
    objects,
    upserted,
    notifications,
    authStates,
    clock,
    intervalCount: () => intervals.length,
    tick: async () => {
      // First tick(s) drain the staggered one-shots; afterwards each tick is one interval round.
      if (pending.length > 0) {
        const run = [...pending];
        pending.length = 0;
        for (const cb of run) {
          cb();
        }
      } else {
        for (const cb of intervals) {
          cb();
        }
      }
      // let the un-awaited pollAccount promises settle
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

const account = (over: Partial<AccountConfig> = {}): AccountConfig => ({
  name: "Router",
  id: "router",
  provider: "openrouter",
  credentialId: "",
  warnThreshold: 80,
  ...over,
});

describe("PollEngine", () => {
  test("creates skeletons, polls, writes snapshot states and totals", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([{ credits: { used: 41.2, limit: 100, percent: 41.2, currency: "USD" } }]);
    const engine = new PollEngine([account()], new Map([["router", provider]]), 300, h.deps);
    await engine.start();
    expect(h.objects).toEqual(
      expect.arrayContaining(["router", "router.info.unreach", "router.info.error", "total.costs.today"]),
    );
    await h.tick();
    expect(provider.fetches).toBe(1);
    expect(h.states.get("router.credits.used")).toBe(41.2);
    expect(h.states.get("router.info.unreach")).toBe(false);
    expect(h.states.get("info.connection")).toBe(true);
    expect(h.states.get("total.accountsReachable")).toBe(1);
    expect(h.states.get("router.warning")).toBe(false);
  });

  test("warn threshold: ONE notification on the upward transition only", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      { limits: [{ name: "week", labelKey: "nameWindowSession", label: "Week", percent: 50 }] },
      { limits: [{ name: "week", labelKey: "nameWindowSession", label: "Week", percent: 85 }] },
      { limits: [{ name: "week", labelKey: "nameWindowSession", label: "Week", percent: 90 }] },
    ]);
    const engine = new PollEngine([account({ id: "c", name: "C" })], new Map([["c", provider]]), 300, h.deps);
    await engine.start();
    await h.tick(); // 50 %
    expect(h.states.get("c.warning")).toBe(false);
    await h.tick(); // 85 % → transition
    expect(h.states.get("c.warning")).toBe(true);
    expect(h.notifications).toHaveLength(1);
    await h.tick(); // 90 % → still warning, no second notification
    expect(h.notifications).toHaveLength(1);
    expect(h.states.get("total.warningsActive")).toBe(1);
  });

  test("auth failure: one notification, account marked offline, recovery resets it", async () => {
    const h = makeHarness();
    const authFail = (): never => {
      throw new FetchError("auth", "401");
    };
    const provider = scriptedProvider([authFail, authFail, { credits: { remaining: 5, currency: "USD" } }, authFail]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    // no data is arriving, so the account reads as offline; the text says why
    expect(h.states.get("a.info.unreach")).toBe(true);
    expect(String(h.states.get("a.info.error"))).toContain("Sign-in rejected");
    expect(h.notifications).toHaveLength(1);
    await h.tick(); // still broken — no second notification
    expect(h.notifications).toHaveLength(1);
    await h.tick(); // recovers
    expect(h.states.get("a.info.error")).toBe("");
    await h.tick(); // breaks again → a NEW notification
    expect(h.notifications).toHaveLength(2);
  });

  test("a rejected sign-in is reported to the settings card — once per transition", async () => {
    // The card must be able to tell a live sign-in from a token file that merely
    // still exists; without this it reported "signed in" off file existence alone.
    const h = makeHarness();
    const authFail = (): never => {
      throw new FetchError("auth", "401");
    };
    const provider = scriptedProvider([authFail, authFail, { credits: { remaining: 5, currency: "USD" } }, authFail]);
    const engine = new PollEngine(
      [account({ id: "claude", name: "Claude" })],
      new Map([["claude", provider]]),
      300,
      h.deps,
    );
    await engine.start();
    await h.tick();
    expect(h.authStates).toEqual([{ accountId: "claude", rejected: true }]);
    await h.tick(); // still rejected — no repeat
    expect(h.authStates).toHaveLength(1);
    await h.tick(); // recovers
    expect(h.authStates[1]).toEqual({ accountId: "claude", rejected: false });
    await h.tick(); // rejected again
    expect(h.authStates[2]).toEqual({ accountId: "claude", rejected: true });
  });

  test("a throttle or a service fault is NOT a rejected sign-in", async () => {
    // Only `auth` means the stored credentials stopped working. A 429 or a 500 must
    // never push the user onto the sign-in screen.
    const h = makeHarness();
    const thrower = (kind: "rate-limit" | "service" | "network"): (() => never) => {
      return () => {
        throw new FetchError(kind, "boom");
      };
    };
    // One account per class: a rate-limit arms a backoff that would swallow the
    // following rounds, so a single account could never exercise all three.
    const limited = scriptedProvider([thrower("rate-limit")]);
    const broken = scriptedProvider([thrower("service")]);
    const offline = scriptedProvider([thrower("network")]);
    const engine = new PollEngine(
      [
        account({ id: "limited", name: "Limited" }),
        account({ id: "broken", name: "Broken" }),
        account({ id: "offline", name: "Offline" }),
      ],
      new Map([
        ["limited", limited],
        ["broken", broken],
        ["offline", offline],
      ]),
      300,
      h.deps,
    );
    await engine.start();
    await h.tick();
    expect(limited.fetches + broken.fetches + offline.fetches).toBe(3);
    expect(h.authStates).toEqual([]);
  });

  test("rate-limit: backoff skips polls and keeps the last values", async () => {
    const h = makeHarness();
    const rateLimited = (): never => {
      throw new FetchError("rate-limit", "429");
    };
    const provider = scriptedProvider([{ credits: { used: 10, currency: "USD" } }, rateLimited, rateLimited]);
    const engine = new PollEngine([account()], new Map([["router", provider]]), 300, h.deps);
    await engine.start();
    await h.tick(); // success
    await h.tick(); // 429 → backoff armed
    expect(provider.fetches).toBe(2);
    expect(h.states.get("router.credits.used")).toBe(10); // last value kept
    await h.tick(); // inside backoff → fetch NOT called
    expect(provider.fetches).toBe(2);
    h.clock.now += 11 * 60 * 1000; // past the first 10-min backoff
    await h.tick();
    expect(provider.fetches).toBe(3);
  });

  test("network failures flip reachable only after three in a row", async () => {
    const h = makeHarness();
    const netFail = (): never => {
      throw new FetchError("network", "timeout");
    };
    const provider = scriptedProvider([{ credits: { used: 1, currency: "USD" } }, netFail, netFail, netFail]);
    const engine = new PollEngine([account()], new Map([["router", provider]]), 300, h.deps);
    await engine.start();
    await h.tick(); // ok
    await h.tick(); // fail 1
    expect(h.states.get("router.info.unreach")).toBe(false);
    await h.tick(); // fail 2
    expect(h.states.get("router.info.unreach")).toBe(false);
    await h.tick(); // fail 3
    expect(h.states.get("router.info.unreach")).toBe(true);
    expect(h.states.get("info.connection")).toBe(false);
  });

  test("the device links its offline state, so the admin draws the connection icon", async () => {
    // Without common.statusStates the object tree shows no icon at all — that link
    // is the ONLY thing the object browser reads for it (krobi 2026-08-26).
    const h = makeHarness();
    const provider = scriptedProvider([
      { limits: [{ name: "week", labelKey: "nameWindowSession", label: "Week", percent: 10 }] },
    ]);
    const engine = new PollEngine([account({ id: "c", name: "Claude" })], new Map([["c", provider]]), 300, h.deps);
    await engine.start();
    expect(h.upserted.get("c")?.common.statusStates).toEqual({ offlineId: "info.unreach" });
  });

  test("the first-round hook fires once, after the LAST account polled", async () => {
    const h = makeHarness();
    const rounds: number[] = [];
    h.deps.afterFirstRound = () => rounds.push(1);
    const a = scriptedProvider([
      { limits: [{ name: "w", labelKey: "nameWindowSession", label: "W", percent: 1 }] },
      { limits: [] },
    ]);
    const b = scriptedProvider([
      { limits: [{ name: "w", labelKey: "nameWindowSession", label: "W", percent: 2 }] },
      { limits: [] },
    ]);
    const engine = new PollEngine(
      [account({ id: "a", name: "A" }), account({ id: "b", name: "B" })],
      new Map([
        ["a", a],
        ["b", b],
      ]),
      300,
      h.deps,
    );
    await engine.start();
    await h.tick(); // both staggered first polls
    expect(rounds).toHaveLength(1);
    await h.tick(); // second round must not report again
    expect(rounds).toHaveLength(1);
  });

  test("with no usable account the hook still fires, so a cleanup-only start is reported", async () => {
    const h = makeHarness();
    let fired = 0;
    h.deps.afterFirstRound = () => void fired++;
    const engine = new PollEngine([account()], new Map(), 300, h.deps);
    await engine.start();
    expect(fired).toBe(1);
  });

  test("an account sitting in a backoff does not hold the first-round report back", async () => {
    const h = makeHarness();
    let fired = 0;
    h.deps.afterFirstRound = () => void fired++;
    const provider = scriptedProvider([
      () => {
        throw new FetchError("rate-limit", "HTTP 429");
      },
      { limits: [] },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick(); // first poll → rate-limited, backoff armed
    expect(fired).toBe(1);
    await h.tick(); // inside the backoff: the poll is skipped, no second report
    expect(fired).toBe(1);
  });

  test("an account without a provider is skipped with a warning", async () => {
    const h = makeHarness();
    const warnings: string[] = [];
    h.deps.log.warn = m => void warnings.push(m);
    const engine = new PollEngine([account()], new Map(), 300, h.deps);
    await engine.start();
    expect(warnings.some(w => w.includes("skipped"))).toBe(true);
    // Nothing is polled, but the user still configured one account.
    await h.tick();
    expect(h.states.get("total.accounts")).toBe(1);
  });

  test("a full window raises limitReached on account and totals", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      { limits: [{ name: "week", labelKey: "nameWindowSession", label: "Week", percent: 100 }] },
    ]);
    const engine = new PollEngine([account({ id: "f", name: "F" })], new Map([["f", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.states.get("f.limitReached")).toBe(true);
    expect(h.states.get("total.limitReached")).toBe(true);
  });

  test("a full MODEL bucket raises neither the warning nor limitReached", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      {
        limits: [
          { name: "session", labelKey: "nameWindowSession", label: "Session (5 h)", percent: 72 },
          { name: "week", labelKey: "nameWindowSession", label: "Week (all models)", percent: 72 },
          {
            name: "weekly_scoped-Fable",
            labelKey: "nameWindowSession",
            label: "weekly scoped Fable",
            percent: 100,
            scoped: true,
          },
        ],
      },
    ]);
    const engine = new PollEngine([account({ id: "c", name: "Claude" })], new Map([["c", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.states.get("c.limitReached")).toBe(false);
    expect(h.states.get("c.warning")).toBe(false);
    expect(h.states.get("total.maxLimitPercent")).toBe(72);
    expect(h.notifications).toEqual([]);
    // the bucket itself is still reported
    expect(h.states.get("c.limits.weekly_scoped-Fable.percent")).toBe(100);
  });

  test("the warning names the window it came from", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      {
        limits: [
          { name: "session", labelKey: "nameWindowSession", label: "Session (5 h)", percent: 40 },
          { name: "week", labelKey: "nameWindowSession", label: "Week (all models)", percent: 91 },
        ],
      },
    ]);
    const engine = new PollEngine([account({ id: "c", name: "Claude" })], new Map([["c", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.notifications).toEqual(["Claude: Week (all models) at 91 % (threshold 80 %)"]);
  });

  test("a rejected sign-in marks the account offline but names the sign-in as the cause", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      { limits: [{ name: "week", labelKey: "nameWindowSession", label: "Week", percent: 10 }] },
      () => {
        throw new FetchError("auth", "HTTP 401");
      },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    await h.tick();
    // no data arrives, so the account reads as offline — the text names the cause
    expect(h.states.get("a.info.unreach")).toBe(true);
    expect(String(h.states.get("a.info.error"))).toContain("Sign-in rejected");
  });

  test("a fault reported BY the service marks it offline at once, without three strikes", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      { limits: [{ name: "week", labelKey: "nameWindowSession", label: "Week", percent: 10 }] },
      () => {
        throw new FetchError("service", "HTTP 503");
      },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.states.get("a.info.unreach")).toBe(false);
    await h.tick();
    expect(h.states.get("a.info.unreach")).toBe(true);
    expect(String(h.states.get("a.info.error"))).toContain("reports a fault");
  });

  test("a single transport hiccup does not make the indicator flap", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      { limits: [{ name: "week", labelKey: "nameWindowSession", label: "Week", percent: 10 }] },
      () => {
        throw new FetchError("network", "ECONNRESET");
      },
      { limits: [{ name: "week", labelKey: "nameWindowSession", label: "Week", percent: 11 }] },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    await h.tick();
    expect(h.states.get("a.info.unreach")).toBe(false);
    expect(h.states.get("a.info.error")).toBe("");
    await h.tick();
    expect(h.states.get("a.info.error")).toBe("");
  });

  test("three transport failures in a row report no connection", async () => {
    const h = makeHarness();
    const boom = (): never => {
      throw new FetchError("network", "ETIMEDOUT");
    };
    const provider = scriptedProvider([
      { limits: [{ name: "week", labelKey: "nameWindowSession", label: "Week", percent: 10 }] },
      boom,
      boom,
      boom,
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.states.get("a.info.unreach")).toBe(true);
    expect(String(h.states.get("a.info.error"))).toContain("Not reachable");
  });

  test("indicators go through the changed-write, measurements through the normal one", async () => {
    // The deduplication is js-controller's job (setStateChangedAsync); the engine's
    // job is to send each kind through the right seam.
    const plain: string[] = [];
    const h = makeHarness();
    const original = h.deps.setState;
    h.deps.setState = (id, value) => {
      plain.push(id);
      original(id, value);
    };
    const provider = scriptedProvider([
      { limits: [{ name: "w", labelKey: "nameWindowSession", label: "W", percent: 10 }] },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    for (const id of ["a.info.unreach", "a.info.error", "a.warning", "a.limitReached", "info.connection"]) {
      expect(h.changedWrites).toContain(id);
      expect(plain).not.toContain(id);
    }
    for (const id of ["a.limits.w.percent", "a.info.lastUpdate", "total.maxLimitPercent"]) {
      expect(plain).toContain(id);
      expect(h.changedWrites).not.toContain(id);
    }
  });

  test("the repeating timer is armed by the staggered first poll, not next to it", async () => {
    // Armed together, all accounts would fire in the same instant from the second
    // round on — the burst the stagger exists to prevent.
    const h = makeHarness();
    const providers = new Map([
      ["a", scriptedProvider([{}, {}])],
      ["b", scriptedProvider([{}, {}])],
      ["c", scriptedProvider([{}, {}])],
    ]);
    const engine = new PollEngine(
      [account({ id: "a", name: "A" }), account({ id: "b", name: "B" }), account({ id: "c", name: "C" })],
      providers,
      300,
      h.deps,
    );
    await engine.start();
    expect(h.intervalCount()).toBe(0);
    await h.tick();
    expect(h.intervalCount()).toBe(3);
  });

  test("an account is marked as not delivering from the start, before it was ever asked", async () => {
    // Whatever the previous run left behind stands until someone overwrites it. After
    // a crash or a hard kill that means an account claiming to deliver while no
    // process exists — so the start says the truth first and the first poll corrects
    // it seconds later.
    const h = makeHarness();
    const provider = scriptedProvider([{}]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    expect(h.states.get("a.info.unreach")).toBe(true);
    // One fleet-wide wording while the adapter has nothing to report — never an
    // adapter-specific sentence.
    expect(h.states.get("a.info.error")).toBe("Unknown");
    await h.tick();
    expect(h.states.get("a.info.unreach")).toBe(false);
    expect(h.states.get("a.info.error")).toBe("");
  });

  test("a window the provider stopped reporting is removed, its channel with it", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      {
        limits: [
          { name: "week", labelKey: "nameWindowSession", label: "Week", percent: 10 },
          { name: "gone", labelKey: "nameWindowSession", label: "Gone", percent: 20 },
        ],
      },
      { limits: [{ name: "week", labelKey: "nameWindowSession", label: "Week", percent: 12 }] },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.deleted).toEqual([]);
    await h.tick();
    expect(h.deleted).toContain("a.limits.gone.percent");
    expect(h.deleted).toContain("a.limits.gone");
    // The surviving window and the skeleton stay untouched.
    expect(h.deleted).not.toContain("a.limits.week.percent");
    expect(h.deleted).not.toContain("a.limits");
    expect(h.deleted.some(id => id.startsWith("a.info"))).toBe(false);
  });

  test("the first round compares against the database, so a restart catches leftovers", async () => {
    const h = makeHarness();
    // Left behind while the adapter was stopped — the in-memory list knows nothing of it.
    h.existing.push("a.limits.old.percent", "a.limits.week.percent");
    const provider = scriptedProvider([
      { limits: [{ name: "week", labelKey: "nameWindowSession", label: "Week", percent: 10 }] },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.deleted).toContain("a.limits.old.percent");
  });

  test("a first poll that fails writes no invented reason into info.error", async () => {
    // A network failure under the tolerance threshold reports nothing yet — and
    // "nothing yet" must not become a sentence about the adapter's own state. The
    // datapoint answers what the SERVICE said.
    const h = makeHarness();
    const boom = (): never => {
      throw new FetchError("network", "ETIMEDOUT");
    };
    const provider = scriptedProvider([boom]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.states.get("a.info.unreach")).toBe(true);
    expect(h.states.get("a.info.error")).toBe("Unknown");
  });

  test("shutting down marks every account as not delivering", async () => {
    // A switched-off instance reads nothing — leaving the accounts on their last
    // value keeps them green in the object tree for as long as it stays off.
    const h = makeHarness();
    const providers = new Map([
      ["a", scriptedProvider([{}])],
      ["b", scriptedProvider([{}])],
    ]);
    const engine = new PollEngine(
      [account({ id: "a", name: "A" }), account({ id: "b", name: "B" })],
      providers,
      300,
      h.deps,
    );
    await engine.start();
    await h.tick();
    expect(h.states.get("a.info.unreach")).toBe(false);
    expect(h.states.get("total.accountsReachable")).toBe(2);

    engine.stop();
    await engine.markAllOffline();
    expect(h.states.get("a.info.unreach")).toBe(true);
    expect(h.states.get("b.info.unreach")).toBe(true);
    // Same single wording as at startup — one word, no explanation appended.
    expect(h.states.get("a.info.error")).toBe("Unknown");
    expect(h.states.get("total.accountsReachable")).toBe(0);
    expect(h.states.get("info.connection")).toBe(false);
  });

  test("a poll requested while one runs does not overlap it, and still happens", async () => {
    // Two token refreshes in parallel sign each other out on a rotating refresh token.
    const h = makeHarness();
    let inFlight = 0;
    let overlapped = false;
    let calls = 0;
    // Each fetch parks on a gate the test opens by hand, so two polls can be made
    // to overlap if the engine lets them.
    const gate: (() => void)[] = [];
    const provider = {
      kind: "deepseek" as const,
      fetch: async (): Promise<UsageSnapshot> => {
        calls++;
        inFlight++;
        overlapped ||= inFlight > 1;
        await new Promise<void>(resolve => gate.push(resolve));
        inFlight--;
        return {};
      },
    };
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    const first = engine.pollNow("a");
    await new Promise(resolve => setImmediate(resolve));
    const second = engine.pollNow("a");
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toBe(1);
    gate.shift()?.();
    await new Promise(resolve => setImmediate(resolve));
    gate.shift()?.();
    await Promise.all([first, second]);
    expect(overlapped).toBe(false);
    expect(calls).toBe(2);
  });
});

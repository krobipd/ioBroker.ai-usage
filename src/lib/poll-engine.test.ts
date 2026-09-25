import { PollEngine, type EngineDeps } from "./poll-engine";
import { mapSnapshot, type ObjectDef } from "./snapshot-tree";
import type { AccountConfig } from "./pure-helpers";
import { FetchError, type LimitWindow, type UsageProvider, type UsageSnapshot } from "./provider";

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
        // A TEST failure, not a provider one. As a bare Error this went through the
        // engine's classification — which now reads a non-FetchError as a service
        // fault, so a test that polls one round too often would quietly assert on
        // "service-down" instead of failing.
        throw new FetchError("service", "TEST BUG: the scripted provider ran out of results");
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
  states: Map<string, boolean | number | string | null>;
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
  /** Every timer ever armed, with its kind and delay — for the stagger/interval rules. */
  scheduled: { kind: "interval" | "once"; ms: number }[];
  /** Every warning the engine logged, in order. */
  warnings: string[];
  /** Every info line the engine logged, in order. */
  infos: string[];
  /** While set, `listStateIds` rejects with this message (the orphan sweep fails). */
  rejectListStateIds: { message: string } | null;
  /** While set, the object database rejects every upsert with this message. */
  rejectUpserts: { message: string } | null;
  /** Make the NEXT upsert wait; returns the function that lets it through. */
  holdNextUpsert(): () => void;
  /** Fire every scheduled one-shot immediately queued and each interval once. */
  tick(): Promise<void>;
  clock: { now: number };
}

function makeHarness(): Harness {
  const states = new Map<string, boolean | number | string | null>();
  const changedWrites: string[] = [];
  const objects: string[] = [];
  const deleted: string[] = [];
  const existing: string[] = [];
  const upserted = new Map<string, ObjectDef>();
  const notifications: string[] = [];
  const authStates: { accountId: string; rejected: boolean }[] = [];
  const pending: (() => void)[] = [];
  const intervals: (() => void)[] = [];
  const scheduled: { kind: "interval" | "once"; ms: number }[] = [];
  const clock = { now: 1_000_000 };
  const warnings: string[] = [];
  const infos: string[] = [];
  const control: {
    rejectUpserts: { message: string } | null;
    rejectListStateIds: { message: string } | null;
    hold: boolean;
    release: (() => void) | null;
  } = {
    rejectUpserts: null,
    rejectListStateIds: null,
    hold: false,
    release: null,
  };
  const deps: EngineDeps = {
    upsertObject: async def => {
      if (control.hold) {
        // One-shot: only the NEXT upsert waits, so the round can finish after release.
        control.hold = false;
        await new Promise<void>(resolve => {
          control.release = resolve;
        });
      }
      if (control.rejectUpserts) {
        throw new Error(control.rejectUpserts.message);
      }
      objects.push(def.id);
      upserted.set(def.id, def);
    },
    deleteObject: id => {
      deleted.push(id);
      return Promise.resolve();
    },
    listStateIds: () => {
      if (control.rejectListStateIds) {
        return Promise.reject(new Error(control.rejectListStateIds.message));
      }
      return Promise.resolve([...existing]);
    },
    readState: id => Promise.resolve(states.get(id) ?? null),
    setState: (id, value) => void states.set(id, value),
    setStateChanged: (id, value) => {
      changedWrites.push(id);
      states.set(id, value);
      return Promise.resolve();
    },
    schedule: (cb, ms) => {
      intervals.push(cb);
      scheduled.push({ kind: "interval", ms });
      return cb;
    },
    scheduleOnce: (cb, ms) => {
      pending.push(cb);
      scheduled.push({ kind: "once", ms });
      return cb;
    },
    // Really removes the timer: a stand-in that ignored its argument let `stop()`
    // lose its cancel loop without a single test noticing — only the `stopped` flag
    // was ever exercised.
    cancel: handle => {
      for (const list of [pending, intervals]) {
        const index = list.indexOf(handle as () => void);
        if (index >= 0) {
          list.splice(index, 1);
        }
      }
    },
    now: () => clock.now,
    log: {
      debug: () => undefined,
      info: m => void infos.push(m),
      warn: m => void warnings.push(m),
      error: () => undefined,
    },
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
    warnings,
    infos,
    get rejectUpserts() {
      return control.rejectUpserts;
    },
    set rejectUpserts(value) {
      control.rejectUpserts = value;
    },
    get rejectListStateIds() {
      return control.rejectListStateIds;
    },
    set rejectListStateIds(value) {
      control.rejectListStateIds = value;
    },
    holdNextUpsert: () => {
      control.hold = true;
      return () => control.release?.();
    },
    intervalCount: () => intervals.length,
    scheduled,
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

  test("a throttled poll leaves the last-update stamp where it was", async () => {
    // `reachable` stays true during a throttle by design: the last values are kept
    // and the account still counts as delivering. The stamp must NOT follow that —
    // it dates those values, and re-dating numbers that were never fetched is the
    // one lie a datapoint called "last successful update" must not tell.
    const h = makeHarness();
    const rateLimited = (): never => {
      throw new FetchError("rate-limit", "429");
    };
    const provider = scriptedProvider([{ credits: { used: 10, currency: "USD" } }, rateLimited]);
    const engine = new PollEngine([account()], new Map([["router", provider]]), 300, h.deps);
    await engine.start();
    await h.tick(); // success — the stamp is set
    const stamped = h.states.get("router.info.lastUpdate");
    expect(stamped).toBe(new Date(h.clock.now).toISOString());
    h.clock.now += 60 * 60 * 1000;
    await h.tick(); // 429 — no snapshot arrived
    expect(provider.fetches).toBe(2);
    expect(h.states.get("router.info.lastUpdate")).toBe(stamped);
    // …while the throttle itself is still not an outage. That pair is the point.
    expect(h.states.get("router.info.unreach")).toBe(false);
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

  test("an account without a usable credential still gets its objects and says so", async () => {
    // It used to be skipped outright: no skeleton, no start stamp. An account whose
    // key had been removed kept its whole tree standing with the last values AND
    // the last status — green, on a key that no longer exists.
    const h = makeHarness();
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map(), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.objects).toContain("a.info.unreach");
    expect(h.states.get("a.info.unreach")).toBe(true);
    expect(String(h.states.get("a.info.error"))).toContain("No API key");
    // Nothing is polled, but the user still configured one account.
    expect(h.states.get("total.accounts")).toBe(1);
    expect(h.states.get("total.accountsReachable")).toBe(0);
    expect(h.intervalCount()).toBe(0);
  });

  test("a credential-less account does not hold the startup report back", async () => {
    const h = makeHarness();
    let reported = 0;
    h.deps.afterFirstRound = () => void reported++;
    const engine = new PollEngine([account({ id: "a" })], new Map(), 300, h.deps);
    await engine.start();
    expect(reported).toBe(1);
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
    for (const id of ["a.limits.w.percent", "a.info.lastUpdate"]) {
      expect(plain).toContain(id);
      expect(h.changedWrites).not.toContain(id);
    }
    // The totals are recomputed after EVERY account's poll — with several accounts
    // that was one write per account per round, nearly always of the value that
    // was already there.
    for (const id of ["total.maxLimitPercent", "total.costs.today", "total.accountsReachable"]) {
      expect(h.changedWrites).toContain(id);
      expect(plain).not.toContain(id);
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

  test("NOT SIGNED IN is not a rejected sign-in: no warning, no notification, no card error", async () => {
    // Running the two together greeted a brand-new account with a warning, an
    // ioBroker notification and a red "the stored sign-in was rejected" — before
    // the user ever reached the sign-in button, and again after every sign-out.
    const h = makeHarness();
    const warnings: string[] = [];
    h.deps.log.warn = m => void warnings.push(m);
    const provider = scriptedProvider([
      () => {
        throw new FetchError("no-credentials", "Not signed in — start the Claude sign-in in the instance settings");
      },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "Claude" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.notifications).toEqual([]);
    expect(h.authStates).toEqual([]);
    expect(warnings).toEqual([]);
    expect(h.states.get("a.info.unreach")).toBe(true);
    expect(String(h.states.get("a.info.error"))).toContain("Not signed in");
  });

  test("a rejected sign-in still warns and notifies — the other half of the split", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      () => {
        throw new FetchError("auth", "HTTP 401");
      },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "Claude" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.notifications).toHaveLength(1);
    expect(h.authStates).toEqual([{ accountId: "a", rejected: true }]);
  });

  test("an answer that arrives AFTER the shutdown writes nothing", async () => {
    // stop() cancels timers; it cannot cancel a request already in flight. The
    // late answer used to overwrite markAllOffline() and leave a stopped adapter
    // claiming the account was online.
    const h = makeHarness();
    let release: (value: UsageSnapshot) => void = () => undefined;
    const provider: UsageProvider = {
      kind: "openrouter",
      fetch: () => new Promise<UsageSnapshot>(resolve => (release = resolve)),
    };
    const engine = new PollEngine([account({ id: "a" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    engine.stop();
    await engine.markAllOffline();
    release({ limits: [{ name: "w", label: "W", labelKey: "nameWindowSession", percent: 10 }] });
    await new Promise(resolve => setImmediate(resolve));
    expect(h.states.get("a.info.unreach")).toBe(true);
    expect(h.states.get("a.limits.w.percent")).toBeUndefined();
  });

  test("the recovery says so too — a warning must not stay the last word", async () => {
    const h = makeHarness();
    const infos: string[] = [];
    h.deps.log.info = m => void infos.push(m);
    const provider = scriptedProvider([
      () => {
        throw new FetchError("service", "HTTP 503");
      },
      { limits: [{ name: "w", label: "W", labelKey: "nameWindowSession", percent: 4 }] },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "Router" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.states.get("a.info.unreach")).toBe(true);
    await h.tick();
    expect(h.states.get("a.info.unreach")).toBe(false);
    // The failure was WARNED — in the first round of the process too (decision 76)
    // — and so the recovery is announced.
    expect(h.warnings.filter(line => line.includes("reports a fault"))).toHaveLength(1);
    expect(infos.some(line => line.includes("delivering again"))).toBe(true);
  });

  test("a window the provider LOCKED reaches limitReached, whatever the percentage says", async () => {
    const h = makeHarness();
    const warnings: string[] = [];
    h.deps.log.warn = m => void warnings.push(m);
    const week = (lockedReason?: string): UsageSnapshot => ({
      limits: [
        {
          name: "week",
          label: "Week (all models)",
          labelKey: "nameWindowWeek",
          percent: 96,
          ...(lockedReason ? { lockedReason } : {}),
        },
      ],
    });
    const provider = scriptedProvider([week(), week("usage_limit_reached")]);
    const engine = new PollEngine([account({ id: "a", name: "Claude" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    await h.tick();
    expect(h.states.get("a.limitReached")).toBe(true);
    expect(warnings.some(w => w.includes("locked by the provider"))).toBe(true);
  });

  test("an indicator from the tree builder goes through the changed-write", async () => {
    // The fleet rule is "every indicator.* through setStateChangedAsync". The two
    // indicators the tree builder produces — a window's `active` flag and DeepSeek's
    // `available` — went through the unconditional write, putting a new timestamp on
    // an unchanged boolean every cycle. The measurements around them do not change.
    const h = makeHarness();
    const provider = scriptedProvider([
      {
        limits: [{ name: "week", labelKey: "nameWindowWeek", label: "Week", percent: 61 }],
        available: true,
      },
    ]);
    const engine = new PollEngine([account({ id: "d", name: "D" })], new Map([["d", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.changedWrites).toContain("d.limits.week.active");
    expect(h.changedWrites).toContain("d.credits.available");
    // …and the measurements stay on the plain write.
    expect(h.changedWrites).not.toContain("d.limits.week.percent");
    expect(h.states.get("d.limits.week.percent")).toBe(61);
  });

  test("a restart above the threshold does not warn or notify again", async () => {
    // Measured with two engines against the same state store: the transition lived
    // in memory only, so every start of the instance looked like a fresh crossing
    // and raised the warning AND the ioBroker notification again — a config change
    // alone restarts the instance, and each notification waits for the user.
    const h = makeHarness();
    const over = (): UsageSnapshot => ({
      limits: [{ name: "week", labelKey: "nameWindowWeek", label: "Week", percent: 85 }],
    });
    const first = new PollEngine(
      [account({ id: "a", name: "A" })],
      new Map([["a", scriptedProvider([over()])]]),
      300,
      h.deps,
    );
    await first.start();
    await h.tick();
    expect(h.states.get("a.warning")).toBe(true);
    expect(h.notifications).toHaveLength(1);
    first.stop();

    // Second process, same database, same value.
    const second = new PollEngine(
      [account({ id: "a", name: "A" })],
      new Map([["a", scriptedProvider([over()])]]),
      300,
      h.deps,
    );
    await second.start();
    await h.tick();
    expect(h.states.get("a.warning")).toBe(true);
    expect(h.notifications).toHaveLength(1);
  });

  test("a threshold crossed WHILE the adapter was off is still reported", async () => {
    // The other half: seeding from the datapoint must not swallow a real crossing.
    const h = makeHarness();
    h.states.set("a.warning", false);
    const provider = scriptedProvider([
      { limits: [{ name: "week", labelKey: "nameWindowWeek", label: "Week", percent: 91 }] },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.states.get("a.warning")).toBe(true);
    expect(h.notifications).toHaveLength(1);
  });

  test("a window that was ALREADY locked when the adapter started logs no transition", async () => {
    // Being locked has no datapoint of its own (decision 36), so the first round of
    // a process has nothing to compare against. Reporting a transition there claims
    // an event nobody observed — and it repeated on every restart while the window
    // had been locked for hours. The state itself is still correct.
    const h = makeHarness();
    const provider = scriptedProvider([
      {
        limits: [
          {
            name: "week",
            label: "Week (all models)",
            labelKey: "nameWindowWeek",
            percent: 42,
            lockedReason: "usage_limit_reached",
          },
        ],
      },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "Claude" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.states.get("a.limitReached")).toBe(true);
    expect(h.warnings.some(w => w.includes("locked by the provider"))).toBe(false);
  });

  test("a throttled account counts as delivering everywhere, not only in the icon", async () => {
    // The icon read the account state while the totals read a second flag: a first
    // poll that hit a throttle left the account green next to "0 reachable".
    const h = makeHarness();
    const provider = scriptedProvider([
      () => {
        throw new FetchError("rate-limit", "HTTP 429");
      },
    ]);
    const engine = new PollEngine([account({ id: "a" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.states.get("a.info.unreach")).toBe(false);
    expect(h.states.get("total.accountsReachable")).toBe(1);
    expect(h.states.get("info.connection")).toBe(true);
  });

  test("the account node carries the readable provider name, not the internal kind", async () => {
    const h = makeHarness();
    const engine = new PollEngine(
      [account({ id: "claude", name: "Claude Max", provider: "claude-sub" })],
      new Map(),
      300,
      h.deps,
    );
    await engine.start();
    expect(h.upserted.get("claude")?.common.name).toBe("Claude Max (Claude)");
  });

  test("a rejected object write is not a provider failure — the account stops claiming to deliver", async () => {
    const h = makeHarness();
    const snapshot: UsageSnapshot = {
      limits: [{ name: "session", labelKey: "nameWindowSession", label: "Session", percent: 12 }],
    };
    const provider = scriptedProvider([snapshot, snapshot, snapshot, snapshot]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    // The database starts refusing AFTER the skeleton is in place.
    h.rejectUpserts = { message: "Objects DB timeout" };
    await h.tick();
    expect(h.states.get("a.info.unreach")).toBe(true);
    expect(h.states.get("a.info.error")).toContain("object database");
    expect(h.states.get("total.accountsReachable")).toBe(0);
    // Filed as a network failure it would have needed three strikes it can never
    // reach, because the counter is reset before every fetch.
    await h.tick();
    await h.tick();
    expect(h.states.get("a.info.unreach")).toBe(true);
  });

  test("a storage failure warns once and then goes quiet", async () => {
    const h = makeHarness();
    const snapshot: UsageSnapshot = { credits: { remaining: 5, currency: "USD" } };
    const provider = scriptedProvider([snapshot, snapshot, snapshot]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    h.rejectUpserts = { message: "Objects DB timeout" };
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.warnings.filter(line => line.includes("could not be stored"))).toHaveLength(1);
  });

  test("the last-update stamp does not move when nothing was written", async () => {
    const h = makeHarness();
    // The second round brings a window the account did not have — that is when the
    // write path touches the object database again on an established account.
    const provider = scriptedProvider([
      { limits: [{ name: "session", labelKey: "nameWindowSession", label: "Session", percent: 12 }] },
      {
        limits: [
          { name: "session", labelKey: "nameWindowSession", label: "Session", percent: 12 },
          { name: "week", labelKey: "nameWindowWeek", label: "Week", percent: 30 },
        ],
      },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    const stamped = h.states.get("a.info.lastUpdate");
    expect(stamped).toBeDefined();
    h.rejectUpserts = { message: "Objects DB timeout" };
    h.clock.now += 600_000;
    await h.tick();
    expect(h.states.get("a.info.lastUpdate")).toBe(stamped);
  });

  test("the totals do not run ahead of a tree that was never written", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      { limits: [{ name: "session", labelKey: "nameWindowSession", label: "Session", percent: 10 }] },
      {
        limits: [
          { name: "session", labelKey: "nameWindowSession", label: "Session", percent: 90 },
          { name: "week", labelKey: "nameWindowWeek", label: "Week", percent: 20 },
        ],
      },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.states.get("total.maxLimitPercent")).toBe(10);
    h.rejectUpserts = { message: "Objects DB timeout" };
    await h.tick();
    // The second snapshot never reached the tree, so the sum must not report it.
    expect(h.states.get("total.maxLimitPercent")).toBe(10);
  });

  test("an answer that carries no window at all sweeps NOTHING", async () => {
    // A provider whose whole limit block fell silent (empty Gemini buckets, a
    // report with no bucket for today). Before the guard this wiped the limit tree
    // and reported the account as perfectly healthy while doing it.
    const h = makeHarness();
    const provider = scriptedProvider([
      {
        limits: [
          { name: "session", labelKey: "nameWindowSession", label: "Session", percent: 95 },
          { name: "week", labelKey: "nameWindowWeek", label: "Week", percent: 60 },
        ],
      },
      {},
    ]);
    const engine = new PollEngine([account({ id: "c", name: "C" })], new Map([["c", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.states.get("c.warning")).toBe(true);
    h.deleted.length = 0;
    await h.tick();
    expect(h.deleted).toEqual([]);
  });

  test("a write waiting on the object database writes nothing after the shutdown", async () => {
    const h = makeHarness();
    // A window the account no longer delivers, so the orphan sweep of this round
    // would have something to DELETE — the part of the write path that must not run
    // once the host has been told the adapter is done.
    h.existing.push("a.limits.old.percent");
    const provider = scriptedProvider([
      { limits: [{ name: "session", labelKey: "nameWindowSession", label: "Session", percent: 42 }] },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    const release = h.holdNextUpsert();
    await h.tick(); // the round is now stuck inside applySnapshot
    // onUnload: cancel the timers, then say that nothing delivers any more.
    engine.stop();
    await engine.markAllOffline();
    expect(h.states.get("a.info.unreach")).toBe(true);
    expect(h.states.get("info.connection")).toBe(false);
    // …and only now does the object database answer. The host has already been told.
    release();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(h.states.get("a.info.unreach")).toBe(true);
    expect(h.states.get("info.connection")).toBe(false);
    expect(h.states.get("total.accountsReachable")).toBe(0);
    // Nothing was written and nothing was deleted after the shutdown stamp.
    expect(h.deleted).toEqual([]);
    expect(h.states.get("a.limits.session.percent")).toBeUndefined();
  });
});

describe("what the audit of 2026-09-15 found", () => {
  test("a tolerated network failure leaves the last-update stamp where it was", async () => {
    // The counterpart to the throttle case (decision 43): the network branch only
    // sets the state on the THIRD strike, so strikes one and two left it on "ok" —
    // and the stamp hung on that state. The round fetched nothing and still dated
    // the values as fresh.
    const h = makeHarness();
    const provider = scriptedProvider([
      { credits: { used: 10, limit: 100, percent: 10, currency: "USD" } },
      () => {
        throw new FetchError("network", "ECONNRESET");
      },
    ]);
    const engine = new PollEngine([account()], new Map([["router", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    const stamped = h.states.get("router.info.lastUpdate");
    expect(stamped).toBeTruthy();
    h.clock.now += 600_000;
    await h.tick();
    // Still green — one hiccup must not flap the indicator (decision 11) …
    expect(h.states.get("router.info.unreach")).toBe(false);
    // … but the values are the ones from ten minutes ago, and the stamp says so.
    expect(h.states.get("router.info.lastUpdate")).toBe(stamped);
  });

  test("an answer that cannot be processed is a service fault, not a lost connection", async () => {
    // Everything that is not a FetchError landed in the network branch: three
    // tolerated attempts, two debug lines, and only then "not reachable" — the one
    // thing that was certainly not the case, because the answer had arrived.
    const h = makeHarness();
    const provider = scriptedProvider([
      { credits: { used: 1, limit: 100, percent: 1, currency: "USD" } },
      () => {
        throw new TypeError("Cannot read properties of undefined (reading 'usage')");
      },
    ]);
    const engine = new PollEngine([account()], new Map([["router", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    await h.tick();
    // At once, not after three strikes, and not as "no connection".
    expect(h.states.get("router.info.unreach")).toBe(true);
    expect(h.states.get("router.info.error")).toContain("could not be processed");
    expect(h.states.get("router.info.error")).not.toContain("Not reachable");
    expect(h.warnings.some(w => w.includes("could not be processed"))).toBe(true);
  });

  test("a failed orphan sweep keeps the round: the values are in the tree", async () => {
    // The sweep ran inside the storage guard, so its failure discarded a round whose
    // values had demonstrably been written: the account reported "fetched but not
    // stored" while its datapoints moved on, and the totals froze on the previous
    // snapshot — two datapoints of one adapter contradicting each other.
    const h = makeHarness();
    const provider = scriptedProvider([
      { credits: { used: 10, limit: 100, percent: 10, currency: "USD" } },
      { credits: { used: 25, limit: 100, percent: 25, currency: "USD" } },
    ]);
    const engine = new PollEngine([account()], new Map([["router", provider]]), 300, h.deps);
    h.rejectListStateIds = { message: "getObjectView: database not connected" };
    await engine.start();
    await h.tick();
    expect(h.states.get("router.credits.used")).toBe(10);
    // The account keeps delivering — nothing the provider sent was lost.
    expect(h.states.get("router.info.unreach")).toBe(false);
    expect(h.states.get("router.info.error")).toBe("");
    expect(h.states.get("router.info.lastUpdate")).toBeTruthy();
    // The totals see the snapshot that reached the tree, not the one before it.
    expect(h.states.get("total.maxLimitPercent")).toBe(10);
    // Said once, then de-duplicated on the category.
    expect(h.warnings.filter(w => w.includes("could not be cleaned up"))).toHaveLength(1);
    await h.tick();
    expect(h.states.get("total.maxLimitPercent")).toBe(25);
    expect(h.warnings.filter(w => w.includes("could not be cleaned up"))).toHaveLength(1);
  });

  test("an answered rejection clears the network strike counter", async () => {
    // Two transport failures, then a throttle — the service demonstrably answered —
    // then one more transport failure. Counting all three together declared the
    // account unreachable on evidence that had been contradicted in between.
    const h = makeHarness();
    const provider = scriptedProvider([
      { credits: { used: 1, limit: 100, percent: 1, currency: "USD" } },
      () => {
        throw new FetchError("network", "ETIMEDOUT");
      },
      () => {
        throw new FetchError("network", "ETIMEDOUT");
      },
      () => {
        throw new FetchError("rate-limit", "HTTP 429");
      },
      () => {
        throw new FetchError("network", "ETIMEDOUT");
      },
    ]);
    const engine = new PollEngine([account()], new Map([["router", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    await h.tick();
    // The throttle answers, and it also arms the backoff — jump past it.
    await h.tick();
    h.clock.now += 3_600_000;
    await h.tick();
    expect(h.states.get("router.info.error")).not.toContain("Not reachable after");
  });

  test("signing out clears the account's alarms and drops it from the totals", async () => {
    // Values stay (decision 6/15) — alarms do not. An account signed out at 100 %
    // held `warning`, `limitReached` and every total that counts them until someone
    // signed in again, and an automation waiting on them never moved.
    const h = makeHarness();
    const provider = scriptedProvider([
      { limits: [{ name: "week", labelKey: "nameWindowWeek", label: "Week", percent: 100 }] },
      () => {
        throw new FetchError("no-credentials", "Not signed in — start the Claude sign-in in the instance settings");
      },
    ]);
    const engine = new PollEngine([account()], new Map([["router", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.states.get("router.warning")).toBe(true);
    expect(h.states.get("router.limitReached")).toBe(true);
    expect(h.states.get("total.limitReached")).toBe(true);
    expect(h.states.get("total.warningsActive")).toBe(1);
    expect(h.states.get("total.maxLimitPercent")).toBe(100);

    await h.tick();
    expect(h.states.get("router.warning")).toBe(false);
    expect(h.states.get("router.limitReached")).toBe(false);
    expect(h.states.get("total.limitReached")).toBe(false);
    expect(h.states.get("total.warningsActive")).toBe(0);
    expect(h.states.get("total.maxLimitPercent")).toBe(0);
    // The measured value stays — it is not a lie, only unattended.
    expect(h.states.get("router.limits.week.percent")).toBe(100);
    expect(h.states.get("router.info.unreach")).toBe(true);
    // Through the comparing write, like every other alarm of this adapter.
    expect(h.changedWrites).toContain("router.warning");
  });

  test("a rejected sign-in keeps the alarms — it is an outage, not a sign-out", async () => {
    // The other half of the rule above: `auth` means the provider REJECTED a
    // sign-in. The account is still watched, so its last known state stands.
    const h = makeHarness();
    const provider = scriptedProvider([
      { limits: [{ name: "week", labelKey: "nameWindowWeek", label: "Week", percent: 100 }] },
      () => {
        throw new FetchError("auth", "HTTP 401");
      },
    ]);
    const engine = new PollEngine([account()], new Map([["router", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    await h.tick();
    expect(h.states.get("router.warning")).toBe(true);
    expect(h.states.get("total.limitReached")).toBe(true);
  });

  test("the first successful poll of a process does not announce a recovery", async () => {
    // Every account starts as "no-connection" (decision 19c), so the first answer
    // always looked like a recovery: one info line per account per restart, about a
    // failure nobody had been told about.
    const h = makeHarness();
    const provider = scriptedProvider([
      { credits: { used: 1, limit: 100, percent: 1, currency: "USD" } },
      () => {
        throw new FetchError("service", "HTTP 503");
      },
      { credits: { used: 2, limit: 100, percent: 2, currency: "USD" } },
    ]);
    const engine = new PollEngine([account()], new Map([["router", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.infos.filter(line => line.includes("delivering again"))).toHaveLength(0);
    await h.tick();
    await h.tick();
    // …but a recovery from a failure the log DID report is still announced.
    expect(h.infos.filter(line => line.includes("delivering again"))).toHaveLength(1);
  });
});

describe("what the fleet sweep of 2026-09-16 found", () => {
  test("a model the report skips keeps its channel and gets a 0", async () => {
    const h = makeHarness();
    // The month boundary. An OpenAI organisation report is fetched from the 1st, so
    // on the 1st it lists only what has already run this month — and decision 49
    // made that list the WHOLE month precisely to stop UTC midnight emptying it.
    // The month rollover was the half left open: the moment the first model of the
    // new month reported usage, every other model's channel was swept away.
    const provider = scriptedProvider([
      {
        tokens: {
          inputToday: 10,
          outputToday: 5,
          perModel: [
            { model: "gpt-5", tokens: 7 },
            { model: "o3", tokens: 3 },
          ],
        },
      },
      { tokens: { inputToday: 2, outputToday: 1, perModel: [{ model: "gpt-5", tokens: 3 }] } },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.states.get("a.models.o3.tokensToday")).toBe(3);
    h.deleted.length = 0;
    await h.tick();
    // The channel is still there…
    expect(h.deleted).toEqual([]);
    // …and it says what is true, rather than freezing on yesterday's 3 under a name
    // that says "today".
    expect(h.states.get("a.models.o3.tokensToday")).toBe(0);
    expect(h.states.get("a.models.gpt-5.tokensToday")).toBe(3);
  });

  test("a limit window that falls out is still swept — only models changed", async () => {
    const h = makeHarness();
    // The counter-test, so the fix cannot be "never delete anything": for `limits.*`
    // the provider reports the PLAN, not usage, so a window that stops appearing
    // really is gone and decision 15 still applies to it unchanged.
    const provider = scriptedProvider([
      {
        limits: [
          { name: "session", labelKey: "nameWindowSession", label: "Session", percent: 42 },
          { name: "week", labelKey: "nameWindowWeek", label: "Week", percent: 10 },
        ],
      },
      { limits: [{ name: "session", labelKey: "nameWindowSession", label: "Session", percent: 50 }] },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    h.deleted.length = 0;
    await h.tick();
    expect(h.deleted.some(id => id.startsWith("a.limits.week"))).toBe(true);
  });
});

/**
 * A limit snapshot with one plan-wide window.
 *
 * @param percent the window's utilisation
 * @param extra further window fields (a lock reason, a scope mark)
 * @returns the snapshot
 */
function planWindow(percent: number, extra: Partial<LimitWindow> = {}): UsageSnapshot {
  return { limits: [{ name: "week", labelKey: "nameWindowWeek", label: "Week", percent, ...extra }] };
}

/** Every snapshot-derived total the engine writes. */
const DERIVED_TOTALS = [
  "total.costs.today",
  "total.costs.month",
  "total.costs.projectedMonth",
  "total.maxLimitPercent",
  "total.warningsActive",
  "total.limitReached",
];

describe("audit 2026-09-25 — the measured probes as tests", () => {
  test("F5: a key account without a provider retires its alarms at startup", async () => {
    const h = makeHarness();
    h.states.set("k.warning", true);
    h.states.set("k.limitReached", true);
    const reasons = new Map([["k", "The selected key no longer exists in the credential storage — pick another"]]);
    const engine = new PollEngine([account({ id: "k", name: "K" })], new Map(), 300, h.deps, reasons);
    await engine.start();
    expect(h.states.get("k.warning")).toBe(false);
    expect(h.states.get("k.limitReached")).toBe(false);
    expect(h.states.get("total.warningsActive")).toBe(0);
    expect(h.states.get("total.limitReached")).toBe(false);
    // The reason the adapter found, not "no key selected" for every case (decision 73).
    expect(String(h.states.get("k.info.error"))).toContain("no longer exists");
  });

  test("R15: a credential that disappears while running retires the account's alarms", async () => {
    const h = makeHarness();
    const engine = new PollEngine(
      [account({ id: "k", name: "K" })],
      new Map([["k", scriptedProvider([planWindow(95)])]]),
      300,
      h.deps,
    );
    await engine.start();
    await h.tick();
    expect(h.states.get("k.warning")).toBe(true);
    await engine.setProvider("k", null, "The selected key no longer exists");
    expect(h.states.get("k.warning")).toBe(false);
    expect(h.states.get("k.limitReached")).toBe(false);
    expect(h.states.get("total.warningsActive")).toBe(0);
    expect(h.states.get("k.info.unreach")).toBe(true);
    expect(h.states.get("k.info.error")).toBe("The selected key no longer exists");
  });

  test("R15: a key that arrives while running arms the account and polls it", async () => {
    const h = makeHarness();
    const engine = new PollEngine([account({ id: "k", name: "K" })], new Map(), 300, h.deps);
    await engine.start();
    expect(h.intervalCount()).toBe(0);
    const provider = scriptedProvider([planWindow(10)]);
    await engine.setProvider("k", provider);
    await h.tick();
    expect(provider.fetches).toBe(1);
    expect(h.intervalCount()).toBe(1);
    expect(h.states.get("k.limits.week.percent")).toBe(10);
  });

  test("F7: a restart does not write the snapshot-derived totals before the first round", async () => {
    const h = makeHarness();
    const engine = new PollEngine(
      [account({ id: "a", name: "A" })],
      new Map([["a", scriptedProvider([planWindow(100)])]]),
      300,
      h.deps,
    );
    await engine.start();
    for (const id of DERIVED_TOTALS) {
      expect(h.changedWrites).not.toContain(id);
    }
    await h.tick();
    expect(h.states.get("total.limitReached")).toBe(true);
  });

  test("F7: a first round that fails keeps total.limitReached where the account's own datapoint stands", async () => {
    for (const failure of [
      (): never => {
        throw new FetchError("rate-limit", "429");
      },
      (): never => {
        throw new FetchError("network", "ENOTFOUND");
      },
    ]) {
      const h = makeHarness();
      h.states.set("a.limitReached", true);
      h.states.set("total.limitReached", true);
      const engine = new PollEngine(
        [account({ id: "a", name: "A" })],
        new Map([["a", scriptedProvider([failure])]]),
        300,
        h.deps,
      );
      await engine.start();
      await h.tick();
      expect(h.states.get("a.limitReached")).toBe(true);
      expect(h.states.get("total.limitReached")).toBe(true);
    }
  });

  test("F6/F7: with no account at all, every total is written as zero", async () => {
    const h = makeHarness();
    h.states.set("total.limitReached", true);
    h.states.set("total.costs.month", 12);
    const engine = new PollEngine([], new Map(), 300, h.deps);
    await engine.start();
    expect(h.states.get("total.limitReached")).toBe(false);
    expect(h.states.get("total.costs.month")).toBe(0);
    expect(h.states.get("total.accounts")).toBe(0);
    expect(h.states.get("info.connection")).toBe(false);
  });

  test("F8: only a model window delivered — it does not raise the warning", async () => {
    const h = makeHarness();
    const engine = new PollEngine(
      [account({ id: "c", name: "C" })],
      new Map([
        [
          "c",
          scriptedProvider([
            {
              limits: [{ name: "fable", label: "Fable", labelKey: "nameWindowModelWeek", percent: 100, scoped: true }],
            },
          ]),
        ],
      ]),
      300,
      h.deps,
    );
    await engine.start();
    await h.tick();
    expect(h.states.get("c.warning")).toBe(false);
    expect(h.states.get("c.limitReached")).toBe(false);
    expect(h.notifications).toEqual([]);
  });

  test("F9: last month's money of a failing account leaves the sums at the month boundary", async () => {
    const h = makeHarness();
    h.clock.now = Date.UTC(2026, 9, 31, 22);
    const fail = (): never => {
      throw new FetchError("service", "500");
    };
    const a = scriptedProvider([{ costs: { today: 3, month: 100, currency: "USD" } }, fail]);
    const b = scriptedProvider([
      { costs: { today: 0, month: 0, currency: "USD" } },
      { costs: { today: 1, month: 1, currency: "USD" } },
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
    await h.tick();
    expect(h.states.get("total.costs.month")).toBe(100);
    h.clock.now = Date.UTC(2026, 10, 1, 2);
    await h.tick();
    expect(h.states.get("total.costs.month")).toBe(1);
    expect(h.states.get("total.costs.today")).toBe(1);
  });

  test("F10: a rejection from before the new sign-in is dropped, not reported again", async () => {
    const h = makeHarness();
    let calls = 0;
    let release: () => void = () => undefined;
    const provider: UsageProvider = {
      kind: "openrouter",
      fetch: async (): Promise<UsageSnapshot> => {
        calls++;
        if (calls === 1) {
          throw new FetchError("auth", "401");
        }
        if (calls === 2) {
          await new Promise<void>(resolve => {
            release = resolve;
          });
          throw new FetchError("auth", "401");
        }
        return planWindow(10);
      },
    };
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    await h.tick();
    const signedIn = engine.pollNow("a");
    release();
    await signedIn;
    await new Promise(resolve => setImmediate(resolve));
    expect(h.notifications).toHaveLength(1);
    expect(calls).toBe(3);
    expect(h.states.get("a.info.unreach")).toBe(false);
  });

  test("F10: a throttle from before the new sign-in does not make the new query wait", async () => {
    const h = makeHarness();
    let calls = 0;
    let release: () => void = () => undefined;
    const provider: UsageProvider = {
      kind: "openrouter",
      fetch: async (): Promise<UsageSnapshot> => {
        calls++;
        if (calls === 1) {
          await new Promise<void>(resolve => {
            release = resolve;
          });
          throw new FetchError("rate-limit", "429");
        }
        return planWindow(10);
      },
    };
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    const signedIn = engine.pollNow("a");
    release();
    await signedIn;
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toBe(2);
    expect(h.states.get("a.limits.week.percent")).toBe(10);
  });

  test("R1: a shutdown during the first sweep's database view deletes and zeroes nothing", async () => {
    const h = makeHarness();
    h.existing.push("a.limits.old.percent", "a.models.o3.tokensToday");
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const list = h.deps.listStateIds;
    h.deps.listStateIds = async prefix => {
      await gate;
      return list(prefix);
    };
    const engine = new PollEngine(
      [account({ id: "a", name: "A" })],
      new Map([["a", scriptedProvider([planWindow(10)])]]),
      300,
      h.deps,
    );
    await engine.start();
    await h.tick();
    engine.stop();
    await engine.markAllOffline();
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.deleted).toEqual([]);
    expect(h.states.has("a.models.o3.tokensToday")).toBe(false);
    expect(h.infos.filter(line => line.includes("removed"))).toEqual([]);
  });

  test("R2: a shutdown during the skeleton leaves the offline stamp standing and arms nothing", async () => {
    const h = makeHarness();
    const release = h.holdNextUpsert();
    const engine = new PollEngine(
      [account({ id: "a", name: "A" }), account({ id: "k", name: "K" })],
      new Map([["a", scriptedProvider([planWindow(10)])]]),
      300,
      h.deps,
    );
    const started = engine.start();
    await new Promise(resolve => setTimeout(resolve, 5));
    engine.stop();
    await engine.markAllOffline();
    release();
    await started;
    expect(h.states.get("k.info.error")).toBe("Unknown");
    expect(h.scheduled).toEqual([]);
    // Only the object that was already on its way when the stop came; nothing after.
    expect(h.objects).toHaveLength(1);
  });

  test("R3: a skeleton the database refuses does not stop the polling for good", async () => {
    const h = makeHarness();
    h.rejectUpserts = { message: "db down" };
    const provider = scriptedProvider([planWindow(10)]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    expect(h.scheduled.some(timer => timer.kind === "once")).toBe(true);
    // One line for the account (and one for the totals — a different object group).
    expect(h.warnings.filter(line => line.startsWith("A: the account's objects could not be created"))).toHaveLength(1);
    h.rejectUpserts = null;
    await h.tick();
    expect(provider.fetches).toBe(1);
    expect(h.objects).toContain("a.info.unreach");
    expect(h.states.get("a.limits.week.percent")).toBe(10);
  });

  test("R6: a fault in the first round of a process is warned once, its repeats are debug", async () => {
    const h = makeHarness();
    const broken = (): never => {
      throw new TypeError("x is undefined");
    };
    const engine = new PollEngine(
      [account({ id: "a", name: "A" })],
      new Map([["a", scriptedProvider([broken, broken])]]),
      300,
      h.deps,
    );
    await engine.start();
    await h.tick();
    await h.tick();
    expect(h.warnings.filter(line => line.includes("could not be processed"))).toHaveLength(1);
  });

  test("R6/N4: a throttle that repeats is warned once", async () => {
    const h = makeHarness();
    const throttled = (): never => {
      throw new FetchError("rate-limit", "429");
    };
    const engine = new PollEngine(
      [account({ id: "a", name: "A" })],
      new Map([["a", scriptedProvider([throttled, throttled, throttled])]]),
      300,
      h.deps,
    );
    await engine.start();
    for (let round = 0; round < 3; round++) {
      await h.tick();
      h.clock.now += 61 * 60_000;
    }
    expect(h.warnings.filter(line => line.includes("rate-limited"))).toHaveLength(1);
  });

  test("R6/N5: a network outage is a state — no warning, and no recovery line afterwards", async () => {
    const h = makeHarness();
    const down = (): never => {
      throw new FetchError("network", "ENOTFOUND");
    };
    const engine = new PollEngine(
      [account({ id: "a", name: "A" })],
      // Delivering first: only a service that WAS online reaches the third-strike
      // line at all — started offline, the test would never touch it.
      new Map([["a", scriptedProvider([planWindow(5), down, down, down, planWindow(10)])]]),
      300,
      h.deps,
    );
    await engine.start();
    for (let round = 0; round < 4; round++) {
      await h.tick();
    }
    expect(String(h.states.get("a.info.error"))).toContain("Not reachable");
    await h.tick();
    expect(h.states.get("a.limits.week.percent")).toBe(10);
    expect(h.warnings).toEqual([]);
    expect(h.infos.filter(line => line.includes("delivering again"))).toEqual([]);
  });

  test("R7: a lock seen on the first delivery after a failed round is no observed transition", async () => {
    const h = makeHarness();
    const down = (): never => {
      throw new FetchError("network", "ENOTFOUND");
    };
    const engine = new PollEngine(
      [account({ id: "a", name: "A" })],
      new Map([["a", scriptedProvider([down, planWindow(100, { lockedReason: "closed" })])]]),
      300,
      h.deps,
    );
    await engine.start();
    await h.tick();
    await h.tick();
    expect(h.warnings.filter(line => line.includes("locked"))).toEqual([]);
    expect(h.states.get("a.limitReached")).toBe(true);
  });

  test("R8: the backoff counts from the start of the round, so the tick at its end polls", async () => {
    const h = makeHarness();
    let calls = 0;
    const provider: UsageProvider = {
      kind: "openrouter",
      fetch: (): Promise<UsageSnapshot> => {
        calls++;
        h.clock.now += 500; // the answer takes half a second
        if (calls === 1) {
          throw new FetchError("rate-limit", "429");
        }
        return Promise.resolve(planWindow(10));
      },
    };
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 600, h.deps);
    await engine.start();
    const roundStart = h.clock.now;
    await h.tick();
    expect(String(h.states.get("a.info.error"))).toContain("about 10 min");
    h.clock.now = roundStart + 600_000;
    await h.tick();
    expect(calls).toBe(2);
  });

  test("R14: a provider asking for a longer wait than our backoff is honoured", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      () => {
        throw new FetchError("rate-limit", "429", { status: 429, retryAfterMs: 30 * 60_000 });
      },
      planWindow(10),
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 600, h.deps);
    await engine.start();
    const roundStart = h.clock.now;
    await h.tick();
    expect(String(h.states.get("a.info.error"))).toContain("about 30 min");
    h.clock.now = roundStart + 20 * 60_000;
    await h.tick();
    expect(provider.fetches).toBe(1);
    h.clock.now = roundStart + 30 * 60_000;
    await h.tick();
    expect(provider.fetches).toBe(2);
  });

  test("R9: a timer tick during a running poll is dropped, a requested poll runs right after", async () => {
    const h = makeHarness();
    let calls = 0;
    let release: () => void = () => undefined;
    const provider: UsageProvider = {
      kind: "openrouter",
      fetch: async (): Promise<UsageSnapshot> => {
        calls++;
        if (calls === 2) {
          await new Promise<void>(resolve => {
            release = resolve;
          });
        }
        return planWindow(10);
      },
    };
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick(); // round 1
    const slow = h.tick(); // round 2 hangs
    await h.tick(); // a tick lands on it
    release();
    await slow;
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toBe(2);

    const second = h.tick();
    const requested = engine.pollNow("a");
    await Promise.all([second, requested]);
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toBe(4);
  });

  test("decision 59: an answered rejection resets the network strike counter", async () => {
    for (const answered of [
      (): never => {
        throw new FetchError("auth", "401");
      },
      (): never => {
        throw new FetchError("no-credentials", "Not signed in");
      },
    ]) {
      const h = makeHarness();
      const down = (): never => {
        throw new FetchError("network", "ENOTFOUND");
      };
      const engine = new PollEngine(
        [account({ id: "a", name: "A" })],
        new Map([["a", scriptedProvider([down, down, answered, down, down])]]),
        300,
        h.deps,
      );
      await engine.start();
      for (let round = 0; round < 5; round++) {
        await h.tick();
      }
      expect(String(h.states.get("a.info.error"))).not.toContain("Not reachable");
    }
  });

  test("the timers: staggered first polls, the interval armed inside them, cancelled on stop", async () => {
    const h = makeHarness();
    const engine = new PollEngine(
      [account({ id: "a", name: "A" }), account({ id: "b", name: "B" })],
      new Map([
        ["a", scriptedProvider([planWindow(1)])],
        ["b", scriptedProvider([planWindow(1)])],
      ]),
      300,
      h.deps,
    );
    await engine.start();
    expect(h.scheduled).toEqual([
      { kind: "once", ms: 0 },
      { kind: "once", ms: 3000 },
    ]);
    await h.tick();
    expect(h.scheduled.filter(timer => timer.kind === "interval")).toEqual([
      { kind: "interval", ms: 300_000 },
      { kind: "interval", ms: 300_000 },
    ]);
    engine.stop();
    expect(h.intervalCount()).toBe(0);
  });

  test("the backoff doubles, stops at an hour and starts over after a success", async () => {
    const h = makeHarness();
    const throttled = (): never => {
      throw new FetchError("rate-limit", "429");
    };
    const engine = new PollEngine(
      [account({ id: "a", name: "A" })],
      new Map([
        ["a", scriptedProvider([throttled, throttled, throttled, throttled, throttled, planWindow(1), throttled])],
      ]),
      300,
      h.deps,
    );
    await engine.start();
    const seen: string[] = [];
    for (let round = 0; round < 7; round++) {
      await h.tick();
      seen.push(String(h.states.get("a.info.error")));
      h.clock.now += 61 * 60_000;
    }
    expect(seen.map(text => /about (\d+) min/.exec(text)?.[1] ?? "-")).toEqual([
      "10",
      "20",
      "40",
      "60",
      "60",
      "-",
      "10",
    ]);
  });

  test("the first-round report fires after the LAST account, not the first", async () => {
    const h = makeHarness();
    let reported = 0;
    h.deps.afterFirstRound = () => void reported++;
    const pending: (() => void)[] = [];
    const slow: UsageProvider = {
      kind: "openrouter",
      fetch: () =>
        new Promise<UsageSnapshot>(resolve => {
          pending.push(() => resolve(planWindow(1)));
        }),
    };
    const engine = new PollEngine(
      [account({ id: "a", name: "A" }), account({ id: "b", name: "B" })],
      new Map<string, UsageProvider>([
        ["a", scriptedProvider([planWindow(1)])],
        ["b", slow],
      ]),
      300,
      h.deps,
    );
    await engine.start();
    await h.tick();
    expect(reported).toBe(0);
    pending.forEach(done => done());
    await new Promise(resolve => setImmediate(resolve));
    expect(reported).toBe(1);
  });

  test("a new sign-in clears the backoff and the rejection before it asks", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      () => {
        throw new FetchError("rate-limit", "429");
      },
      planWindow(5),
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    await engine.pollNow("a");
    expect(provider.fetches).toBe(2);
    expect(h.states.get("a.limits.week.percent")).toBe(5);
  });
});

// The mutation run of 2026-09-25 found stop checks and a swap path that no test told
// apart from their neighbours: each one here stops or swaps at exactly the point only
// that check (or that call) covers.
describe("each stop check on its own, and the key swap of an armed account", () => {
  /**
   * The objects a snapshot adds on top of the skeleton, in the order they are created.
   *
   * @param h the harness after `start()`
   * @param snapshot the snapshot the round will deliver
   * @returns the ids the round has to create
   */
  function freshIds(h: Harness, snapshot: UsageSnapshot): string[] {
    return mapSnapshot("a", snapshot)
      .objects.map(object => object.id)
      .filter(id => !h.objects.includes(id));
  }

  test("a shutdown during a snapshot's first new object creates no further one", async () => {
    const h = makeHarness();
    const snapshot = planWindow(10);
    const engine = new PollEngine(
      [account({ id: "a", name: "A" })],
      new Map([["a", scriptedProvider([snapshot])]]),
      300,
      h.deps,
    );
    await engine.start();
    const fresh = freshIds(h, snapshot);
    expect(fresh.length).toBeGreaterThan(1);
    const upsert = h.deps.upsertObject;
    h.deps.upsertObject = async def => {
      await upsert(def);
      if (def.id === fresh[0]) {
        engine.stop();
      }
    };
    await h.tick();
    expect(h.objects.filter(id => fresh.includes(id))).toEqual([fresh[0]]);
  });

  test("a shutdown during a snapshot's LAST new object writes no value", async () => {
    const h = makeHarness();
    const snapshot = planWindow(10);
    const engine = new PollEngine(
      [account({ id: "a", name: "A" })],
      new Map([["a", scriptedProvider([snapshot])]]),
      300,
      h.deps,
    );
    await engine.start();
    const fresh = freshIds(h, snapshot);
    const upsert = h.deps.upsertObject;
    h.deps.upsertObject = async def => {
      await upsert(def);
      if (def.id === fresh[fresh.length - 1]) {
        engine.stop();
      }
    };
    await h.tick();
    expect(h.objects).toContain(fresh[fresh.length - 1]);
    expect(h.states.has("a.limits.week.percent")).toBe(false);
  });

  test("a shutdown during the first deletion of the sweep deletes nothing more", async () => {
    const h = makeHarness();
    h.existing.push("a.limits.old1.percent", "a.limits.old2.percent");
    const engine = new PollEngine(
      [account({ id: "a", name: "A" })],
      new Map([["a", scriptedProvider([planWindow(10)])]]),
      300,
      h.deps,
    );
    await engine.start();
    h.deps.deleteObject = id => {
      h.deleted.push(id);
      engine.stop();
      return Promise.resolve();
    };
    await h.tick();
    expect(h.deleted).toHaveLength(1);
  });

  test("a shutdown while the totals are created arms no timer", async () => {
    const h = makeHarness();
    const engine = new PollEngine(
      [account({ id: "a", name: "A" })],
      new Map([["a", scriptedProvider([])]]),
      300,
      h.deps,
    );
    const upsert = h.deps.upsertObject;
    h.deps.upsertObject = async def => {
      await upsert(def);
      if (def.id.startsWith("total")) {
        engine.stop();
      }
    };
    await engine.start();
    expect(h.objects.some(id => id.startsWith("total"))).toBe(true);
    expect(h.scheduled).toEqual([]);
  });

  test("a shutdown during the skeleton's last object leaves the offline stamp standing", async () => {
    const h = makeHarness();
    const reasons = new Map([["k", "The selected key no longer exists"]]);
    const engine = new PollEngine([account({ id: "k", name: "K" })], new Map(), 300, h.deps, reasons);
    const upsert = h.deps.upsertObject;
    h.deps.upsertObject = async def => {
      await upsert(def);
      if (def.id === "k.limitReached") {
        engine.stop();
        await engine.markAllOffline();
      }
    };
    await engine.start();
    expect(h.states.get("k.info.error")).toBe("Unknown");
  });

  test("R15: a key replaced on an account that is already polling is asked at once", async () => {
    const h = makeHarness();
    const first = scriptedProvider([planWindow(10)]);
    const engine = new PollEngine([account({ id: "k", name: "K" })], new Map([["k", first]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(first.fetches).toBe(1);
    const second = scriptedProvider([planWindow(20)]);
    await engine.setProvider("k", second);
    // No tick: the new key answers now, not up to an interval later.
    expect(second.fetches).toBe(1);
    expect(h.states.get("k.limits.week.percent")).toBe(20);
  });
});

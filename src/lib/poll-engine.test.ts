import { PollEngine, type EngineDeps } from "./poll-engine";
import type { AccountConfig } from "./pure-helpers";
import { FetchError, type UsageProvider, type UsageSnapshot } from "./provider";

/** A scripted provider: shift one result per fetch (value = snapshot, function = thrower). */
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
  objects: string[];
  notifications: string[];
  /** Fire every scheduled one-shot immediately queued and each interval once. */
  tick(): Promise<void>;
  clock: { now: number };
}

function makeHarness(): Harness {
  const states = new Map<string, boolean | number | string>();
  const objects: string[] = [];
  const notifications: string[] = [];
  const pending: (() => void)[] = [];
  const intervals: (() => void)[] = [];
  const clock = { now: 1_000_000 };
  const deps: EngineDeps = {
    upsertObject: def => {
      objects.push(def.id);
      return Promise.resolve();
    },
    setState: (id, value) => void states.set(id, value),
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
  };
  return {
    deps,
    states,
    objects,
    notifications,
    clock,
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
    expect(h.objects).toEqual(expect.arrayContaining(["router", "router.info.unreach", "router.info.error", "total.costs.today"]));
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
      { limits: [{ name: "week", label: "Week", percent: 50 }] },
      { limits: [{ name: "week", label: "Week", percent: 85 }] },
      { limits: [{ name: "week", label: "Week", percent: 90 }] },
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

  test("auth failure: one notification, service stays marked reachable, recovery resets it", async () => {
    const h = makeHarness();
    const authFail = (): never => {
      throw new FetchError("auth", "401");
    };
    const provider = scriptedProvider([authFail, authFail, { credits: { remaining: 5, currency: "USD" } }, authFail]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    // the service answered with 401 — it is up, so the offline marker stays off
    expect(h.states.get("a.info.unreach")).toBe(false);
    expect(String(h.states.get("a.info.error"))).toContain("Sign-in rejected");
    expect(h.notifications).toHaveLength(1);
    await h.tick(); // still broken — no second notification
    expect(h.notifications).toHaveLength(1);
    await h.tick(); // recovers
    expect(h.states.get("a.info.error")).toBe("");
    await h.tick(); // breaks again → a NEW notification
    expect(h.notifications).toHaveLength(2);
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
    const provider = scriptedProvider([
      { credits: { used: 1, currency: "USD" } },
      netFail,
      netFail,
      netFail,
    ]);
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

  test("an account without a provider is skipped with a warning", async () => {
    const h = makeHarness();
    const warnings: string[] = [];
    h.deps.log.warn = m => void warnings.push(m);
    const engine = new PollEngine([account()], new Map(), 300, h.deps);
    await engine.start();
    expect(warnings.some(w => w.includes("skipped"))).toBe(true);
    expect(engine.accountIds).toEqual([]);
  });

  test("a full window raises limitReached on account and totals", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([{ limits: [{ name: "week", label: "Week", percent: 100 }] }]);
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
          { name: "session", label: "Session (5 h)", percent: 72 },
          { name: "week", label: "Week (all models)", percent: 72 },
          { name: "weekly_scoped-Fable", label: "weekly scoped Fable", percent: 100, scoped: true },
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
          { name: "session", label: "Session (5 h)", percent: 40 },
          { name: "week", label: "Week (all models)", percent: 91 },
        ],
      },
    ]);
    const engine = new PollEngine([account({ id: "c", name: "Claude" })], new Map([["c", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    expect(h.notifications).toEqual(["Claude: Week (all models) at 91 % (threshold 80 %)"]);
  });

  test("a rejected sign-in leaves the AI service marked online — it answered", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      { limits: [{ name: "week", label: "Week", percent: 10 }] },
      () => {
        throw new FetchError("auth", "HTTP 401");
      },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    await h.tick();
    // the service answered with 401 — it is up, only our access is broken
    expect(h.states.get("a.info.unreach")).toBe(false);
    expect(String(h.states.get("a.info.error"))).toContain("Sign-in rejected");
  });

  test("a fault reported BY the service marks it offline at once, without three strikes", async () => {
    const h = makeHarness();
    const provider = scriptedProvider([
      { limits: [{ name: "week", label: "Week", percent: 10 }] },
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
      { limits: [{ name: "week", label: "Week", percent: 10 }] },
      () => {
        throw new FetchError("network", "ECONNRESET");
      },
      { limits: [{ name: "week", label: "Week", percent: 11 }] },
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
      { limits: [{ name: "week", label: "Week", percent: 10 }] },
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

  test("an unchanged state is not written again", async () => {
    const writes: string[] = [];
    const h = makeHarness();
    const original = h.deps.setState;
    h.deps.setState = (id, value) => {
      writes.push(id);
      original(id, value);
    };
    const provider = scriptedProvider([
      { limits: [{ name: "week", label: "Week", percent: 10 }] },
      { limits: [{ name: "week", label: "Week", percent: 11 }] },
    ]);
    const engine = new PollEngine([account({ id: "a", name: "A" })], new Map([["a", provider]]), 300, h.deps);
    await engine.start();
    await h.tick();
    const before = writes.filter(id => id === "a.info.error").length;
    await h.tick();
    expect(writes.filter(id => id === "a.info.error").length).toBe(before);
  });
});

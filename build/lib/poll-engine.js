"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var poll_engine_exports = {};
__export(poll_engine_exports, {
  PollEngine: () => PollEngine
});
module.exports = __toCommonJS(poll_engine_exports);
var import_provider = require("./provider");
var import_snapshot_tree = require("./snapshot-tree");
var import_totals = require("./totals");
const MAX_NETWORK_FAILURES = 3;
const BACKOFF_START_MS = 10 * 60 * 1e3;
const BACKOFF_MAX_MS = 60 * 60 * 1e3;
const STAGGER_MS = 3e3;
class PollEngine {
  /**
   * @param accounts the validated account configs
   * @param providers each account id's provider (accounts without one are skipped)
   * @param intervalSec the poll interval in seconds
   * @param deps the injected adapter callbacks
   */
  constructor(accounts, providers, intervalSec, deps) {
    this.intervalSec = intervalSec;
    this.deps = deps;
    for (const config of accounts) {
      const provider = providers.get(config.id);
      if (!provider) {
        deps.log.warn(`${config.name}: provider "${config.provider}" is not available \u2014 account skipped`);
        continue;
      }
      this.runtimes.push({
        config,
        provider,
        status: { reachable: false, warning: false },
        failCount: 0,
        skipUntil: 0,
        backoffMs: BACKOFF_START_MS,
        authNotified: false,
        createdObjects: /* @__PURE__ */ new Set()
      });
    }
  }
  intervalSec;
  deps;
  runtimes = [];
  handles = [];
  stopped = false;
  /** Create the static per-account and totals objects, then arm the poll cycles. */
  async start() {
    for (const runtime of this.runtimes) {
      await this.createAccountSkeleton(runtime);
    }
    await this.createTotalsSkeleton();
    await this.writeTotals();
    this.runtimes.forEach((runtime, index) => {
      this.handles.push(
        this.deps.scheduleOnce(() => void this.pollAccount(runtime), index * STAGGER_MS),
        this.deps.schedule(() => void this.pollAccount(runtime), this.intervalSec * 1e3)
      );
    });
  }
  /** Cancel every timer. Synchronous — safe from onUnload. */
  stop() {
    this.stopped = true;
    for (const handle of this.handles) {
      this.deps.cancel(handle);
    }
    this.handles.length = 0;
  }
  /** The account ids the engine drives (for the stale-object cleanup). */
  get accountIds() {
    return this.runtimes.map((runtime) => runtime.config.id);
  }
  /**
   * Poll one account now (also used by the staggered first run).
   *
   * @param runtime the account's runtime
   */
  async pollAccount(runtime) {
    if (this.stopped) {
      return;
    }
    const { config } = runtime;
    if (this.deps.now() < runtime.skipUntil) {
      this.deps.log.debug(`${config.name}: in rate-limit backoff \u2014 poll skipped`);
      return;
    }
    try {
      const snapshot = await runtime.provider.fetch();
      runtime.failCount = 0;
      runtime.backoffMs = BACKOFF_START_MS;
      runtime.authNotified = false;
      runtime.status.snapshot = snapshot;
      runtime.status.reachable = true;
      await this.applySnapshot(runtime, snapshot);
    } catch (e) {
      this.handleFailure(runtime, e);
    }
    this.writeAccountInfo(runtime);
    await this.writeTotals();
  }
  /**
   * Write a successful snapshot: upsert new objects (create-once cache), write the
   * values, and run the warn-threshold transition.
   *
   * @param runtime the account's runtime
   * @param snapshot the fetched snapshot
   */
  async applySnapshot(runtime, snapshot) {
    var _a, _b, _c;
    const { config } = runtime;
    const { objects, writes } = (0, import_snapshot_tree.mapSnapshot)(config.id, config.name, config.provider, snapshot);
    for (const object of objects) {
      if (!runtime.createdObjects.has(object.id)) {
        await this.deps.upsertObject(object);
        runtime.createdObjects.add(object.id);
      }
    }
    for (const write of writes) {
      this.deps.setState(write.id, write.value);
    }
    const percent = (_a = (0, import_snapshot_tree.maxLimitPercent)(snapshot)) != null ? _a : 0;
    const wasWarning = runtime.status.warning;
    runtime.status.warning = percent >= config.warnThreshold;
    this.deps.setState(`${config.id}.warning`, runtime.status.warning);
    this.deps.setState(`${config.id}.limitReached`, percent >= 100);
    if (runtime.status.warning && !wasWarning) {
      const message = `${config.name}: usage at ${Math.round(percent)} % (threshold ${config.warnThreshold} %)`;
      this.deps.log.warn(message);
      (_c = (_b = this.deps).notify) == null ? void 0 : _c.call(_b, config.name, message);
    }
  }
  /**
   * Classify a fetch failure: auth = unreachable + ONE notification until it recovers;
   * rate-limit = backoff, last values stay; network = tolerated MAX_NETWORK_FAILURES times.
   *
   * @param runtime the account's runtime
   * @param error the thrown error
   */
  handleFailure(runtime, error) {
    var _a, _b;
    const { config } = runtime;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof import_provider.FetchError && error.kind === "auth") {
      runtime.status.reachable = false;
      if (!runtime.authNotified) {
        runtime.authNotified = true;
        const text = `${config.name}: credentials rejected \u2014 ${message}`;
        this.deps.log.warn(text);
        (_b = (_a = this.deps).notify) == null ? void 0 : _b.call(_a, config.name, text);
      }
      return;
    }
    if (error instanceof import_provider.FetchError && error.kind === "rate-limit") {
      runtime.skipUntil = this.deps.now() + runtime.backoffMs;
      this.deps.log.warn(
        `${config.name}: rate-limited \u2014 backing off for ${Math.round(runtime.backoffMs / 6e4)} min, keeping last values`
      );
      runtime.backoffMs = Math.min(BACKOFF_MAX_MS, runtime.backoffMs * 2);
      return;
    }
    runtime.failCount++;
    this.deps.log.debug(`${config.name}: fetch failed (${message}), attempt ${runtime.failCount}`);
    if (runtime.failCount >= MAX_NETWORK_FAILURES) {
      runtime.status.reachable = false;
    }
  }
  /**
   * Write one account's info states (reachable, last update).
   *
   * @param runtime the account's runtime
   */
  writeAccountInfo(runtime) {
    const { config } = runtime;
    this.deps.setState(`${config.id}.info.reachable`, runtime.status.reachable);
    if (runtime.status.reachable) {
      this.deps.setState(`${config.id}.info.lastUpdate`, new Date(this.deps.now()).toISOString());
    }
  }
  /** Recompute and write the totals + info.connection. */
  async writeTotals() {
    const totals = (0, import_totals.computeTotals)(this.runtimes.map((runtime) => runtime.status));
    this.deps.setState("total.costs.today", totals.costsToday);
    this.deps.setState("total.costs.month", totals.costsMonth);
    this.deps.setState("total.costs.projectedMonth", totals.costsProjectedMonth);
    this.deps.setState("total.maxLimitPercent", totals.maxLimitPercent);
    this.deps.setState("total.warningsActive", totals.warningsActive);
    this.deps.setState("total.limitReached", totals.limitReached);
    this.deps.setState("total.accountsReachable", totals.accountsReachable);
    this.deps.setState("total.accounts", totals.accounts);
    this.deps.setState("info.connection", totals.accountsReachable > 0);
    return Promise.resolve();
  }
  /**
   * The static per-account objects that exist regardless of what the source delivers.
   *
   * @param runtime the account's runtime
   */
  async createAccountSkeleton(runtime) {
    const { config } = runtime;
    const defs = [
      { id: config.id, type: "device", common: { name: `${config.name} (${config.provider})` } },
      { id: `${config.id}.info`, type: "channel", common: { name: "Info" } },
      {
        id: `${config.id}.info.provider`,
        type: "state",
        common: { name: "Provider", type: "string", role: "text", read: true, write: false }
      },
      {
        id: `${config.id}.info.reachable`,
        type: "state",
        common: { name: "Reachable", type: "boolean", role: "indicator.reachable", read: true, write: false }
      },
      {
        id: `${config.id}.info.lastUpdate`,
        type: "state",
        common: { name: "Last successful update", type: "string", role: "date", read: true, write: false }
      },
      {
        id: `${config.id}.warning`,
        type: "state",
        common: { name: "Above warn threshold", type: "boolean", role: "indicator", read: true, write: false }
      },
      {
        id: `${config.id}.limitReached`,
        type: "state",
        common: { name: "A limit window is full", type: "boolean", role: "indicator", read: true, write: false }
      }
    ];
    for (const def of defs) {
      await this.deps.upsertObject(def);
      runtime.createdObjects.add(def.id);
    }
    this.deps.setState(`${config.id}.info.provider`, config.provider);
    this.deps.setState(`${config.id}.info.reachable`, false);
  }
  /** The totals skeleton (channel + states). */
  async createTotalsSkeleton() {
    const defs = [
      { id: "total.costs", type: "channel", common: { name: "Costs (USD accounts)" } },
      {
        id: "total.costs.today",
        type: "state",
        common: {
          name: "Costs today (all accounts)",
          type: "number",
          role: "value",
          read: true,
          write: false,
          unit: "USD"
        }
      },
      {
        id: "total.costs.month",
        type: "state",
        common: {
          name: "Costs this month (all accounts)",
          type: "number",
          role: "value",
          read: true,
          write: false,
          unit: "USD"
        }
      },
      {
        id: "total.costs.projectedMonth",
        type: "state",
        common: {
          name: "Costs projected month-end (computed)",
          type: "number",
          role: "value",
          read: true,
          write: false,
          unit: "USD"
        }
      },
      {
        id: "total.maxLimitPercent",
        type: "state",
        common: {
          name: "Highest limit utilisation of any account",
          type: "number",
          role: "value",
          read: true,
          write: false,
          unit: "%"
        }
      },
      {
        id: "total.warningsActive",
        type: "state",
        common: {
          name: "Accounts above their warn threshold",
          type: "number",
          role: "value",
          read: true,
          write: false
        }
      },
      {
        id: "total.limitReached",
        type: "state",
        common: { name: "Any limit window full", type: "boolean", role: "indicator", read: true, write: false }
      },
      {
        id: "total.accountsReachable",
        type: "state",
        common: { name: "Reachable accounts", type: "number", role: "value", read: true, write: false }
      },
      {
        id: "total.accounts",
        type: "state",
        common: { name: "Configured accounts", type: "number", role: "value", read: true, write: false }
      }
    ];
    for (const def of defs) {
      await this.deps.upsertObject(def);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PollEngine
});
//# sourceMappingURL=poll-engine.js.map

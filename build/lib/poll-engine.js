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
    this.configuredAccounts = accounts.length;
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
        serviceOnline: false,
        state: "no-connection",
        error: "waiting for the first query",
        createdObjects: /* @__PURE__ */ new Set(),
        firstPollDone: false,
        polling: false,
        pollAgain: false,
        deliveredIds: null,
        staticIds: []
      });
    }
  }
  intervalSec;
  deps;
  runtimes = [];
  handles = [];
  stopped = false;
  firstRoundReported = false;
  /**
   * How many accounts the user switched on — including those the adapter cannot
   * poll because their credential is missing. `total.accounts` is what the user
   * configured, not what happened to work out.
   */
  configuredAccounts;
  /** Create the static per-account and totals objects, then arm the poll cycles. */
  async start() {
    for (const runtime of this.runtimes) {
      await this.createAccountSkeleton(runtime);
    }
    await this.createTotalsSkeleton();
    this.writeTotals();
    if (this.runtimes.length === 0) {
      this.reportFirstRoundOnce();
      return;
    }
    this.runtimes.forEach((runtime, index) => {
      this.handles.push(
        this.deps.scheduleOnce(() => {
          if (this.stopped) {
            return;
          }
          this.handles.push(this.deps.schedule(() => void this.pollAccount(runtime), this.intervalSec * 1e3));
          void this.pollAccount(runtime);
        }, index * STAGGER_MS)
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
  /**
   * Say that no account is delivering any more — for shutdown.
   *
   * A stopped adapter reads nothing, so it must not leave every account claiming to
   * be online: `info.unreach` is what colours the account in the admin's object tree
   * and the badge in the settings, and on its last value it stays green for as long
   * as the instance is switched off.
   *
   * The returned promise is what makes this WORK. Measured on the live server
   * 2026-08-27: issued fire-and-forget and followed by an immediate `callback()`,
   * not one of these writes ever reached the database — the process was gone first.
   * The caller has to wait for this (with its own time limit) before saying it is
   * done.
   *
   * @returns resolves once every write has been acknowledged
   */
  async markAllOffline() {
    const writes = [];
    for (const runtime of this.runtimes) {
      writes.push(this.deps.setStateChanged(`${runtime.config.id}.info.unreach`, true));
      writes.push(
        this.deps.setStateChanged(`${runtime.config.id}.info.error`, "The adapter is stopped \u2014 nothing is being read")
      );
    }
    writes.push(this.deps.setStateChanged("total.accountsReachable", 0));
    writes.push(this.deps.setStateChanged("info.connection", false));
    await Promise.all(writes);
  }
  /**
   * Poll one account immediately, by id. Used after a successful sign-in: waiting
   * up to a full interval there reads as "the sign-in did not work".
   *
   * @param accountId the account's object id
   */
  async pollNow(accountId) {
    const runtime = this.runtimes.find((entry) => entry.config.id === accountId);
    if (runtime) {
      runtime.authNotified = false;
      runtime.skipUntil = 0;
      await this.pollAccount(runtime);
    }
  }
  /**
   * Poll one account now (also used by the staggered first run).
   *
   * Never two at once for the same account: a sign-in triggers an immediate poll,
   * which can land on top of a scheduled one — and two token refreshes in parallel
   * on a rotating refresh token sign each other out. A request that arrives while
   * one is running is remembered and runs right after, so nothing is lost.
   *
   * @param runtime the account's runtime
   */
  async pollAccount(runtime) {
    if (this.stopped) {
      return;
    }
    if (runtime.polling) {
      runtime.pollAgain = true;
      return;
    }
    runtime.polling = true;
    try {
      await this.pollOnce(runtime);
    } finally {
      runtime.polling = false;
    }
    if (runtime.pollAgain && !this.stopped) {
      runtime.pollAgain = false;
      await this.pollAccount(runtime);
    }
  }
  /**
   * One poll of one account: fetch, classify, write.
   *
   * @param runtime the account's runtime
   */
  async pollOnce(runtime) {
    const { config } = runtime;
    if (this.deps.now() < runtime.skipUntil) {
      this.deps.log.debug(`${config.name}: in rate-limit backoff \u2014 poll skipped`);
      runtime.firstPollDone = true;
      this.reportFirstRoundOnce();
      return;
    }
    try {
      const snapshot = await runtime.provider.fetch();
      runtime.failCount = 0;
      runtime.backoffMs = BACKOFF_START_MS;
      runtime.authNotified = false;
      runtime.status.snapshot = snapshot;
      runtime.status.reachable = true;
      runtime.serviceOnline = true;
      runtime.state = "ok";
      runtime.error = "";
      await this.applySnapshot(runtime, snapshot);
    } catch (e) {
      this.handleFailure(runtime, e);
    }
    this.writeAccountInfo(runtime);
    this.writeTotals();
    runtime.firstPollDone = true;
    this.reportFirstRoundOnce();
  }
  /** Fire the first-round hook exactly once, when no account is still pending. */
  reportFirstRoundOnce() {
    var _a, _b;
    if (this.firstRoundReported || this.runtimes.some((runtime) => !runtime.firstPollDone)) {
      return;
    }
    this.firstRoundReported = true;
    (_b = (_a = this.deps).afterFirstRound) == null ? void 0 : _b.call(_a);
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
    const { objects, writes } = (0, import_snapshot_tree.mapSnapshot)(config.id, snapshot);
    for (const object of objects) {
      if (!runtime.createdObjects.has(object.id)) {
        await this.deps.upsertObject(object);
        runtime.createdObjects.add(object.id);
      }
    }
    for (const write of writes) {
      this.deps.setState(write.id, write.value);
    }
    await this.removeVanished(
      runtime,
      writes.map((write) => write.id)
    );
    const driver = (0, import_snapshot_tree.limitingWindow)(snapshot);
    const percent = (_a = driver == null ? void 0 : driver.percent) != null ? _a : 0;
    const wasWarning = runtime.status.warning;
    runtime.status.warning = percent >= config.warnThreshold;
    void this.deps.setStateChanged(`${config.id}.warning`, runtime.status.warning);
    void this.deps.setStateChanged(`${config.id}.limitReached`, percent >= 100);
    if (runtime.status.warning && !wasWarning) {
      const window = driver ? `${driver.label} ` : "";
      const message = `${config.name}: ${window}at ${Math.round(percent)} % (threshold ${config.warnThreshold} %)`;
      this.deps.log.warn(message);
      (_c = (_b = this.deps).notify) == null ? void 0 : _c.call(_b, config.name, message);
    }
  }
  /**
   * Delete what this account no longer delivers.
   *
   * The first round after a start compares against the DATABASE, so a window or
   * model that disappeared while the adapter was stopped is caught as well; every
   * round after that compares against the previous snapshot, which costs nothing.
   *
   * @param runtime the account's runtime
   * @param delivered the state ids this snapshot wrote
   */
  async removeVanished(runtime, delivered) {
    var _a;
    const known = (_a = runtime.deliveredIds) != null ? _a : await this.deps.listStateIds(runtime.config.id);
    for (const id of (0, import_snapshot_tree.orphanObjectIds)(known, delivered, runtime.staticIds)) {
      await this.deps.deleteObject(id);
      runtime.createdObjects.delete(id);
      this.deps.log.info(`${runtime.config.name}: removed "${id}" \u2014 the provider no longer reports it`);
    }
    runtime.deliveredIds = delivered;
  }
  /**
   * Classify a fetch failure.
   *
   * The split matters for the online indicator: with `auth` and `rate-limit` the AI
   * service ANSWERED — it is online, it just said no — so only our own access is
   * broken. `service` means the service answered with a fault of its own and is
   * reported as down at once (it told us, that is not a flake). A `network` failure
   * is tolerated MAX_NETWORK_FAILURES times before we call the connection gone, so
   * a single hiccup does not make the indicator flap.
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
      runtime.serviceOnline = true;
      runtime.state = "unauthorized";
      runtime.error = `Sign-in rejected \u2014 ${message}`;
      if (!runtime.authNotified) {
        runtime.authNotified = true;
        const text = `${config.name}: credentials rejected \u2014 ${message}`;
        this.deps.log.warn(text);
        (_b = (_a = this.deps).notify) == null ? void 0 : _b.call(_a, config.name, text);
      }
      return;
    }
    if (error instanceof import_provider.FetchError && error.kind === "rate-limit") {
      runtime.serviceOnline = true;
      runtime.state = "rate-limited";
      runtime.error = `Throttled by the provider \u2014 retrying in ${Math.round(runtime.backoffMs / 6e4)} min, last values kept`;
      runtime.skipUntil = this.deps.now() + runtime.backoffMs;
      this.deps.log.warn(
        `${config.name}: rate-limited \u2014 backing off for ${Math.round(runtime.backoffMs / 6e4)} min, keeping last values`
      );
      runtime.backoffMs = Math.min(BACKOFF_MAX_MS, runtime.backoffMs * 2);
      return;
    }
    if (error instanceof import_provider.FetchError && error.kind === "service") {
      runtime.status.reachable = false;
      runtime.failCount = 0;
      if (runtime.serviceOnline) {
        this.deps.log.warn(`${config.name}: the service reports a fault (${message}) \u2014 values kept`);
      }
      runtime.serviceOnline = false;
      runtime.state = "service-down";
      runtime.error = `The AI service reports a fault \u2014 ${message}`;
      return;
    }
    runtime.failCount++;
    this.deps.log.debug(`${config.name}: fetch failed (${message}), attempt ${runtime.failCount}`);
    if (runtime.failCount >= MAX_NETWORK_FAILURES) {
      runtime.status.reachable = false;
      if (runtime.serviceOnline) {
        this.deps.log.warn(`${config.name}: not reachable after ${runtime.failCount} attempts (${message})`);
      }
      runtime.serviceOnline = false;
      runtime.state = "no-connection";
      runtime.error = `Not reachable after ${runtime.failCount} attempts \u2014 ${message}`;
    }
  }
  /**
   * Write one account's info states (offline marker, error text, last update).
   *
   * @param runtime the account's runtime
   */
  writeAccountInfo(runtime) {
    const { config } = runtime;
    void this.writeAccountStatus(runtime);
    if (runtime.status.reachable) {
      this.deps.setState(`${config.id}.info.lastUpdate`, new Date(this.deps.now()).toISOString());
    }
  }
  /**
   * Write the two status states.
   *
   * `unreach` drives the connection icon the admin draws next to the account, so it
   * has to mean what a user reads into that icon: green while the account delivers.
   * A throttle keeps the last values and the service is fine, so it stays green and
   * only fills the error text; a dead sign-in, a broken service or no connection at
   * all turn it off. Both go through the changed-write: an indicator rewritten every
   * cycle floods the history and hides the real transition.
   *
   * @param runtime the account's runtime
   */
  async writeAccountStatus(runtime) {
    const { config } = runtime;
    const delivering = runtime.state === "ok" || runtime.state === "rate-limited";
    await Promise.all([
      this.deps.setStateChanged(`${config.id}.info.unreach`, !delivering),
      this.deps.setStateChanged(`${config.id}.info.error`, runtime.error)
    ]);
  }
  /** Recompute and write the totals + info.connection. */
  writeTotals() {
    const totals = (0, import_totals.computeTotals)(
      this.runtimes.map((runtime) => runtime.status),
      this.configuredAccounts
    );
    this.deps.setState("total.costs.today", totals.costsToday);
    this.deps.setState("total.costs.month", totals.costsMonth);
    this.deps.setState("total.costs.projectedMonth", totals.costsProjectedMonth);
    this.deps.setState("total.maxLimitPercent", totals.maxLimitPercent);
    this.deps.setState("total.warningsActive", totals.warningsActive);
    void this.deps.setStateChanged("total.limitReached", totals.limitReached);
    this.deps.setState("total.accountsReachable", totals.accountsReachable);
    void this.deps.setStateChanged("total.accounts", totals.accounts);
    void this.deps.setStateChanged("info.connection", totals.accountsReachable > 0);
  }
  /**
   * The static per-account objects that exist regardless of what the source delivers.
   *
   * @param runtime the account's runtime
   */
  async createAccountSkeleton(runtime) {
    const { config } = runtime;
    const defs = [
      {
        id: config.id,
        type: "device",
        common: {
          name: `${config.name} (${config.provider})`,
          // The admin's object tree draws its connection icon from this link and
          // from nothing else — govee, beszel, homewizard and nut2 all do the same.
          statusStates: { offlineId: "info.unreach" }
        }
      },
      { id: `${config.id}.info`, type: "channel", common: { name: "Info" } },
      {
        // The two slots ioBroker itself provides for this — measured against
        // @iobroker/type-detector 6.0.0: `unreach` is the offline marker every
        // device type carries (`indicator.reachable` is deprecated there), and
        // `indicator.error` is the standard home for the reason.
        id: `${config.id}.info.unreach`,
        type: "state",
        common: {
          name: "AI service not reachable",
          type: "boolean",
          role: "indicator.maintenance.unreach",
          read: true,
          write: false
        }
      },
      {
        // NOT `indicator.error`: the two official sources disagree — the type-detector
        // lists that role as a String, the repochecker's validity whitelist allows
        // boolean only (E1009). Validity wins, so the message rides on `text`.
        id: `${config.id}.info.error`,
        type: "state",
        common: { name: "Last error", type: "string", role: "text", read: true, write: false }
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
        common: {
          name: "A plan-wide limit window is full",
          type: "boolean",
          role: "indicator",
          read: true,
          write: false
        }
      }
    ];
    for (const def of defs) {
      await this.deps.upsertObject(def);
      runtime.createdObjects.add(def.id);
    }
    runtime.staticIds = defs.filter((def) => def.type === "state").map((def) => def.id);
    void this.writeAccountStatus(runtime);
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
          name: "Highest plan-wide utilisation of any account",
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
        common: {
          name: "Any plan-wide limit window full",
          type: "boolean",
          role: "indicator",
          read: true,
          write: false
        }
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

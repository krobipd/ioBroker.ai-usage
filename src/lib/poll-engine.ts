import type { AccountConfig } from "./pure-helpers";
import { FetchError, type UsageProvider, type UsageSnapshot } from "./provider";
import { limitingWindow, mapSnapshot, type ObjectDef } from "./snapshot-tree";
import { computeTotals, type AccountStatus } from "./totals";

/**
 * What the adapter currently knows about one account, in one word.
 *
 * `ok` and `rate-limited` mean the AI service is up and talking to us,
 * `unauthorized` means it is up but rejects our sign-in, `service-down` means the
 * service itself answered with a fault, `no-connection` means we never reached it.
 */
export type AccountState = "ok" | "unauthorized" | "rate-limited" | "service-down" | "no-connection";

/** Consecutive network failures after which an account is judged unreachable. */
const MAX_NETWORK_FAILURES = 3;
/** First backoff after a rate-limit answer (ms); doubles per repeat. */
const BACKOFF_START_MS = 10 * 60 * 1000;
/** Backoff ceiling (ms). */
const BACKOFF_MAX_MS = 60 * 60 * 1000;
/** Stagger between the accounts' first polls (ms) so they never fire in one burst. */
const STAGGER_MS = 3000;

/** The adapter callbacks the engine drives — narrow, so tests need no adapter mock. */
export interface EngineDeps {
  /** Create or update an object. */
  upsertObject(def: ObjectDef): Promise<void>;
  /** Write a state value with ack. */
  setState(id: string, value: boolean | number | string): void;
  /** Schedule a repeating callback; returns a cancel handle. */
  schedule(cb: () => void, ms: number): unknown;
  /** Schedule a one-shot callback; returns a cancel handle. */
  scheduleOnce(cb: () => void, ms: number): unknown;
  /** Cancel a handle from schedule/scheduleOnce. */
  cancel(handle: unknown): void;
  /** Current time (ms since epoch) — injected for tests. */
  now(): number;
  /** Adapter log. */
  log: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string): void };
  /** Raise a user-facing notification (threshold crossing, broken credentials). */
  notify?(accountName: string, message: string): void;
}

/** One account's runtime state inside the engine. */
interface AccountRuntime {
  config: AccountConfig;
  provider: UsageProvider;
  status: AccountStatus;
  /** Consecutive network failures. */
  failCount: number;
  /** Skip polls until this time (rate-limit backoff). */
  skipUntil: number;
  /** Current backoff length (ms). */
  backoffMs: number;
  /** Whether the auth-broken notification has been raised (reset on success). */
  authNotified: boolean;
  /** Whether the AI service itself answered on the last attempt. */
  serviceOnline: boolean;
  /** The account's one-word state. */
  state: AccountState;
  /** Plain-text reason shown in `info.error`; empty while everything works. */
  error: string;
  /** Object ids already created for this account (create-once cache). */
  createdObjects: Set<string>;
  /** Last written value per state id — keeps unchanged values out of the history. */
  written: Map<string, boolean | number | string>;
}

/**
 * Drives the polling of all configured accounts: staggered starts, one independent
 * cycle per account, typed failure handling (auth = immediate + one notification,
 * rate-limit = backoff keeping last values, service = reported down at once,
 * network = tolerated three times), warn-threshold transitions on the PLAN-WIDE
 * windows only, and the adapter-wide totals. Pure orchestration — all IO is injected.
 */
export class PollEngine {
  private readonly runtimes: AccountRuntime[] = [];
  private readonly handles: unknown[] = [];
  private stopped = false;

  /**
   * @param accounts the validated account configs
   * @param providers each account id's provider (accounts without one are skipped)
   * @param intervalSec the poll interval in seconds
   * @param deps the injected adapter callbacks
   */
  public constructor(
    accounts: readonly AccountConfig[],
    providers: ReadonlyMap<string, UsageProvider>,
    private readonly intervalSec: number,
    private readonly deps: EngineDeps,
  ) {
    for (const config of accounts) {
      const provider = providers.get(config.id);
      if (!provider) {
        deps.log.warn(`${config.name}: provider "${config.provider}" is not available — account skipped`);
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
        createdObjects: new Set(),
        written: new Map(),
      });
    }
  }

  /** Create the static per-account and totals objects, then arm the poll cycles. */
  public async start(): Promise<void> {
    for (const runtime of this.runtimes) {
      await this.createAccountSkeleton(runtime);
    }
    await this.createTotalsSkeleton();
    await this.writeTotals();
    this.runtimes.forEach((runtime, index) => {
      this.handles.push(
        this.deps.scheduleOnce(() => void this.pollAccount(runtime), index * STAGGER_MS),
        this.deps.schedule(() => void this.pollAccount(runtime), this.intervalSec * 1000),
      );
    });
  }

  /** Cancel every timer. Synchronous — safe from onUnload. */
  public stop(): void {
    this.stopped = true;
    for (const handle of this.handles) {
      this.deps.cancel(handle);
    }
    this.handles.length = 0;
  }

  /** The account ids the engine drives (for the stale-object cleanup). */
  public get accountIds(): string[] {
    return this.runtimes.map(runtime => runtime.config.id);
  }

  /**
   * Poll one account immediately, by id. Used after a successful sign-in: waiting
   * up to a full interval there reads as "the sign-in did not work".
   *
   * @param accountId the account's object id
   */
  public async pollNow(accountId: string): Promise<void> {
    const runtime = this.runtimes.find(entry => entry.config.id === accountId);
    if (runtime) {
      // A fresh sign-in clears a previous auth failure and any backoff.
      runtime.authNotified = false;
      runtime.skipUntil = 0;
      await this.pollAccount(runtime);
    }
  }

  /**
   * Poll one account now (also used by the staggered first run).
   *
   * @param runtime the account's runtime
   */
  private async pollAccount(runtime: AccountRuntime): Promise<void> {
    if (this.stopped) {
      return;
    }
    const { config } = runtime;
    if (this.deps.now() < runtime.skipUntil) {
      this.deps.log.debug(`${config.name}: in rate-limit backoff — poll skipped`);
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
    await this.writeTotals();
  }

  /**
   * Write a successful snapshot: upsert new objects (create-once cache), write the
   * values, and run the warn-threshold transition.
   *
   * @param runtime the account's runtime
   * @param snapshot the fetched snapshot
   */
  private async applySnapshot(runtime: AccountRuntime, snapshot: UsageSnapshot): Promise<void> {
    const { config } = runtime;
    const { objects, writes } = mapSnapshot(config.id, config.name, config.provider, snapshot);
    for (const object of objects) {
      if (!runtime.createdObjects.has(object.id)) {
        await this.deps.upsertObject(object);
        runtime.createdObjects.add(object.id);
      }
    }
    for (const write of writes) {
      this.deps.setState(write.id, write.value);
    }
    // Only PLAN-WIDE windows speak for the account — a per-model bucket at 100 %
    // must not read as "this AI is full" (krobi 2026-08-26).
    const driver = limitingWindow(snapshot);
    const percent = driver?.percent ?? 0;
    const wasWarning = runtime.status.warning;
    runtime.status.warning = percent >= config.warnThreshold;
    this.deps.setState(`${config.id}.warning`, runtime.status.warning);
    this.deps.setState(`${config.id}.limitReached`, percent >= 100);
    if (runtime.status.warning && !wasWarning) {
      // Always name the window: "usage at 100 %" without it was misleading whenever
      // several windows existed.
      const window = driver ? `${driver.label} ` : "";
      const message = `${config.name}: ${window}at ${Math.round(percent)} % (threshold ${config.warnThreshold} %)`;
      this.deps.log.warn(message);
      this.deps.notify?.(config.name, message);
    }
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
  private handleFailure(runtime: AccountRuntime, error: unknown): void {
    const { config } = runtime;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof FetchError && error.kind === "auth") {
      runtime.status.reachable = false;
      runtime.serviceOnline = true;
      runtime.state = "unauthorized";
      runtime.error = `Sign-in rejected — ${message}`;
      if (!runtime.authNotified) {
        runtime.authNotified = true;
        const text = `${config.name}: credentials rejected — ${message}`;
        this.deps.log.warn(text);
        this.deps.notify?.(config.name, text);
      }
      return;
    }
    if (error instanceof FetchError && error.kind === "rate-limit") {
      runtime.serviceOnline = true;
      runtime.state = "rate-limited";
      runtime.error = `Throttled by the provider — retrying in ${Math.round(runtime.backoffMs / 60000)} min, last values kept`;
      runtime.skipUntil = this.deps.now() + runtime.backoffMs;
      this.deps.log.warn(
        `${config.name}: rate-limited — backing off for ${Math.round(runtime.backoffMs / 60000)} min, keeping last values`,
      );
      runtime.backoffMs = Math.min(BACKOFF_MAX_MS, runtime.backoffMs * 2);
      return;
    }
    if (error instanceof FetchError && error.kind === "service") {
      runtime.status.reachable = false;
      runtime.failCount = 0;
      if (runtime.serviceOnline) {
        this.deps.log.warn(`${config.name}: the service reports a fault (${message}) — values kept`);
      }
      runtime.serviceOnline = false;
      runtime.state = "service-down";
      runtime.error = `The AI service reports a fault — ${message}`;
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
      runtime.error = `Not reachable after ${runtime.failCount} attempts — ${message}`;
    }
  }

  /**
   * Write one account's info states (data received, service online, state, last update).
   *
   * @param runtime the account's runtime
   */
  private writeAccountInfo(runtime: AccountRuntime): void {
    const { config } = runtime;
    this.writeAccountStatus(runtime);
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
   * all turn it off. Both states are written on change only — an indicator rewritten
   * every cycle floods the history and hides the real transition.
   *
   * @param runtime the account's runtime
   */
  private writeAccountStatus(runtime: AccountRuntime): void {
    const { config } = runtime;
    const delivering = runtime.state === "ok" || runtime.state === "rate-limited";
    this.setIfChanged(runtime, `${config.id}.info.unreach`, !delivering);
    this.setIfChanged(runtime, `${config.id}.info.error`, runtime.error);
  }

  /**
   * Write a state only when its value actually changed since the last write.
   *
   * @param runtime the account's runtime (holds the last-written cache)
   * @param id the state id
   * @param value the value
   */
  private setIfChanged(runtime: AccountRuntime, id: string, value: boolean | number | string): void {
    if (runtime.written.get(id) === value) {
      return;
    }
    runtime.written.set(id, value);
    this.deps.setState(id, value);
  }

  /** Recompute and write the totals + info.connection. */
  private async writeTotals(): Promise<void> {
    const totals = computeTotals(this.runtimes.map(runtime => runtime.status));
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
  private async createAccountSkeleton(runtime: AccountRuntime): Promise<void> {
    const { config } = runtime;
    const defs: ObjectDef[] = [
      {
        id: config.id,
        type: "device",
        common: {
          name: `${config.name} (${config.provider})`,
          // The admin's object tree draws its connection icon from this link and
          // from nothing else — govee, beszel, homewizard and nut2 all do the same.
          statusStates: { offlineId: "info.unreach" },
        },
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
          write: false,
        },
      },
      {
        // NOT `indicator.error`: the two official sources disagree — the type-detector
        // lists that role as a String, the repochecker's validity whitelist allows
        // boolean only (E1009). Validity wins, so the message rides on `text`.
        id: `${config.id}.info.error`,
        type: "state",
        common: { name: "Last error", type: "string", role: "text", read: true, write: false },
      },
      {
        id: `${config.id}.info.lastUpdate`,
        type: "state",
        common: { name: "Last successful update", type: "string", role: "date", read: true, write: false },
      },
      {
        id: `${config.id}.warning`,
        type: "state",
        common: { name: "Above warn threshold", type: "boolean", role: "indicator", read: true, write: false },
      },
      {
        id: `${config.id}.limitReached`,
        type: "state",
        common: {
          name: "A plan-wide limit window is full",
          type: "boolean",
          role: "indicator",
          read: true,
          write: false,
        },
      },
    ];
    for (const def of defs) {
      await this.deps.upsertObject(def);
      runtime.createdObjects.add(def.id);
    }
    this.writeAccountStatus(runtime);
  }

  /** The totals skeleton (channel + states). */
  private async createTotalsSkeleton(): Promise<void> {
    const defs: ObjectDef[] = [
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
          unit: "USD",
        },
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
          unit: "USD",
        },
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
          unit: "USD",
        },
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
          unit: "%",
        },
      },
      {
        id: "total.warningsActive",
        type: "state",
        common: {
          name: "Accounts above their warn threshold",
          type: "number",
          role: "value",
          read: true,
          write: false,
        },
      },
      {
        id: "total.limitReached",
        type: "state",
        common: {
          name: "Any plan-wide limit window full",
          type: "boolean",
          role: "indicator",
          read: true,
          write: false,
        },
      },
      {
        id: "total.accountsReachable",
        type: "state",
        common: { name: "Reachable accounts", type: "number", role: "value", read: true, write: false },
      },
      {
        id: "total.accounts",
        type: "state",
        common: { name: "Configured accounts", type: "number", role: "value", read: true, write: false },
      },
    ];
    for (const def of defs) {
      await this.deps.upsertObject(def);
    }
  }
}

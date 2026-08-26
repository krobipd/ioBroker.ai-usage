import type { AccountConfig } from "./pure-helpers";
import { FetchError, type UsageProvider, type UsageSnapshot } from "./provider";
import { mapSnapshot, maxLimitPercent, type ObjectDef } from "./snapshot-tree";
import { computeTotals, type AccountStatus } from "./totals";

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
  /** Object ids already created for this account (create-once cache). */
  createdObjects: Set<string>;
}

/**
 * Drives the polling of all configured accounts: staggered starts, one independent
 * cycle per account, typed failure handling (auth = immediate + one notification,
 * rate-limit = backoff keeping last values, network = tolerant), warn-threshold
 * transitions and the adapter-wide totals. Pure orchestration — all IO is injected.
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
        createdObjects: new Set(),
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
    const percent = maxLimitPercent(snapshot) ?? 0;
    const wasWarning = runtime.status.warning;
    runtime.status.warning = percent >= config.warnThreshold;
    this.deps.setState(`${config.id}.warning`, runtime.status.warning);
    this.deps.setState(`${config.id}.limitReached`, percent >= 100);
    if (runtime.status.warning && !wasWarning) {
      const message = `${config.name}: usage at ${Math.round(percent)} % (threshold ${config.warnThreshold} %)`;
      this.deps.log.warn(message);
      this.deps.notify?.(config.name, message);
    }
  }

  /**
   * Classify a fetch failure: auth = unreachable + ONE notification until it recovers;
   * rate-limit = backoff, last values stay; network = tolerated MAX_NETWORK_FAILURES times.
   *
   * @param runtime the account's runtime
   * @param error the thrown error
   */
  private handleFailure(runtime: AccountRuntime, error: unknown): void {
    const { config } = runtime;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof FetchError && error.kind === "auth") {
      runtime.status.reachable = false;
      if (!runtime.authNotified) {
        runtime.authNotified = true;
        const text = `${config.name}: credentials rejected — ${message}`;
        this.deps.log.warn(text);
        this.deps.notify?.(config.name, text);
      }
      return;
    }
    if (error instanceof FetchError && error.kind === "rate-limit") {
      runtime.skipUntil = this.deps.now() + runtime.backoffMs;
      this.deps.log.warn(
        `${config.name}: rate-limited — backing off for ${Math.round(runtime.backoffMs / 60000)} min, keeping last values`,
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
  private writeAccountInfo(runtime: AccountRuntime): void {
    const { config } = runtime;
    this.deps.setState(`${config.id}.info.reachable`, runtime.status.reachable);
    if (runtime.status.reachable) {
      this.deps.setState(`${config.id}.info.lastUpdate`, new Date(this.deps.now()).toISOString());
    }
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
      { id: config.id, type: "device", common: { name: `${config.name} (${config.provider})` } },
      { id: `${config.id}.info`, type: "channel", common: { name: "Info" } },
      {
        id: `${config.id}.info.provider`,
        type: "state",
        common: { name: "Provider", type: "string", role: "text", read: true, write: false },
      },
      {
        id: `${config.id}.info.reachable`,
        type: "state",
        common: { name: "Reachable", type: "boolean", role: "indicator.reachable", read: true, write: false },
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
        common: { name: "A limit window is full", type: "boolean", role: "indicator", read: true, write: false },
      },
    ];
    for (const def of defs) {
      await this.deps.upsertObject(def);
      runtime.createdObjects.add(def.id);
    }
    this.deps.setState(`${config.id}.info.provider`, config.provider);
    this.deps.setState(`${config.id}.info.reachable`, false);
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
          name: "Highest limit utilisation of any account",
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
        common: { name: "Any limit window full", type: "boolean", role: "indicator", read: true, write: false },
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

import type { AccountConfig } from "./pure-helpers";
import { FetchError, type UsageProvider, type UsageSnapshot } from "./provider";
import { limitingWindow, mapSnapshot, orphanObjectIds, type ObjectDef } from "./snapshot-tree";
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

/**
 * What `info.error` says while the adapter itself has nothing to report: switched
 * off, or started and not asked yet.
 *
 * ONE wording for the whole fleet (krobi 2026-08-27) — the datapoint otherwise ends
 * up saying something different in every adapter. It stays a single word: the field
 * names the reason, it does not explain itself.
 */
const REASON_UNKNOWN = "Unknown";

/** The adapter callbacks the engine drives — narrow, so tests need no adapter mock. */
export interface EngineDeps {
  /** Create or update an object. */
  upsertObject(def: ObjectDef): Promise<void>;
  /** Delete an object and everything below it. */
  deleteObject(id: string): Promise<void>;
  /** Every state id that currently exists below `prefix` (relative to the instance). */
  listStateIds(prefix: string): Promise<string[]>;
  /** Write a state value with ack — for MEASUREMENTS, where every cycle carries information. */
  setState(id: string, value: boolean | number | string): void;
  /**
   * Write a state only when the value differs from what the database holds — for
   * INDICATORS. js-controller does the comparison (`setStateChangedAsync`), which is
   * what the rest of the fleet uses; a hand-rolled cache would only know what this
   * process wrote and would still write blindly after a restart.
   *
   * Returns a promise so the shutdown path can WAIT for its writes; everywhere else
   * it is deliberately ignored — a poll cycle must not be held up by the database.
   */
  setStateChanged(id: string, value: boolean | number | string): Promise<void>;
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
  /**
   * Called once, when every account has finished its FIRST poll.
   *
   * The first round is staggered on purpose, so the adapter cannot report what the
   * object tree gained until the last account has been through. A config change
   * restarts the instance, so this is also the only moment a user needs the report.
   */
  afterFirstRound?(): void;
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
  /** Whether this account has been through its first poll. */
  firstPollDone: boolean;
  /** True while a poll of this account is in flight — a second one must not overlap. */
  polling: boolean;
  /** Set when a poll was requested while one was running; runs once the current one ends. */
  pollAgain: boolean;
  /**
   * The dynamic state ids the last snapshot delivered, or null until the first
   * reconcile — which reads the database, so a datapoint that vanished while the
   * adapter was stopped is caught too.
   */
  deliveredIds: string[] | null;
  /** The skeleton's own state ids — they never expire. */
  staticIds: string[];
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
  private firstRoundReported = false;
  /**
   * How many accounts the user switched on — including those the adapter cannot
   * poll because their credential is missing. `total.accounts` is what the user
   * configured, not what happened to work out.
   */
  private readonly configuredAccounts: number;

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
    this.configuredAccounts = accounts.length;
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
        // Nothing known until the service says something; the skeleton writes
        // REASON_UNKNOWN, and the first answer replaces it.
        error: REASON_UNKNOWN,
        createdObjects: new Set(),
        firstPollDone: false,
        polling: false,
        pollAgain: false,
        deliveredIds: null,
        staticIds: [],
      });
    }
  }

  /** Create the static per-account and totals objects, then arm the poll cycles. */
  public async start(): Promise<void> {
    for (const runtime of this.runtimes) {
      await this.createAccountSkeleton(runtime);
    }
    await this.createTotalsSkeleton();
    this.writeTotals();
    if (this.runtimes.length === 0) {
      // Nothing will ever poll — report right away, the cleanup may still have changed something.
      this.reportFirstRoundOnce();
      return;
    }
    this.runtimes.forEach((runtime, index) => {
      // The repeating timer is armed INSIDE the staggered first poll, not next to
      // it: armed here it would start counting for every account in the same
      // instant, and from the second round on all of them would fire together —
      // exactly the burst the stagger exists to prevent, against providers that
      // answer a burst by locking the whole account for a day.
      this.handles.push(
        this.deps.scheduleOnce(() => {
          if (this.stopped) {
            return;
          }
          this.handles.push(this.deps.schedule(() => void this.pollAccount(runtime), this.intervalSec * 1000));
          void this.pollAccount(runtime);
        }, index * STAGGER_MS),
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

  /**
   * Say that no account is delivering any more — for shutdown.
   *
   * A stopped adapter reads nothing, so it must not leave every account claiming to
   * be online: `info.unreach` is what colours the account in the admin's object tree
   * and the badge in the settings, and on its last value it stays green for as long
   * as the instance is switched off.
   *
   * `info.error` is deliberately NOT touched. That datapoint answers "what did the AI
   * service say", and the adapter being switched off is not something the service
   * said — a sentence about our own operating state in there reads as if the provider
   * had reported it. Whatever the last real reason was stays readable.
   *
   * The returned promise is what makes this WORK. Measured on the live server
   * 2026-08-27: issued fire-and-forget and followed by an immediate `callback()`,
   * not one of these writes ever reached the database — the process was gone first.
   * The caller has to wait for this before telling the host it is done — the host's
   * own deadline is the only limit there is.
   *
   * @returns resolves once every write has been acknowledged
   */
  public async markAllOffline(): Promise<void> {
    const writes = this.runtimes.flatMap(runtime => [
      this.deps.setStateChanged(`${runtime.config.id}.info.unreach`, true),
      this.deps.setStateChanged(`${runtime.config.id}.info.error`, REASON_UNKNOWN),
    ]);
    // The same lie one level up: "accounts currently delivering data" is zero.
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
   * Never two at once for the same account: a sign-in triggers an immediate poll,
   * which can land on top of a scheduled one — and two token refreshes in parallel
   * on a rotating refresh token sign each other out. A request that arrives while
   * one is running is remembered and runs right after, so nothing is lost.
   *
   * @param runtime the account's runtime
   */
  private async pollAccount(runtime: AccountRuntime): Promise<void> {
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
  private async pollOnce(runtime: AccountRuntime): Promise<void> {
    const { config } = runtime;
    if (this.deps.now() < runtime.skipUntil) {
      this.deps.log.debug(`${config.name}: in rate-limit backoff — poll skipped`);
      // Still counts as "been through": otherwise an account that starts inside a
      // backoff would hold the first-round report back forever.
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
  private reportFirstRoundOnce(): void {
    if (this.firstRoundReported || this.runtimes.some(runtime => !runtime.firstPollDone)) {
      return;
    }
    this.firstRoundReported = true;
    this.deps.afterFirstRound?.();
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
    const { objects, writes } = mapSnapshot(config.id, snapshot);
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
      writes.map(write => write.id),
    );
    // Only PLAN-WIDE windows speak for the account — a per-model bucket at 100 %
    // must not read as "this AI is full" (krobi 2026-08-26).
    const driver = limitingWindow(snapshot);
    const percent = driver?.percent ?? 0;
    const wasWarning = runtime.status.warning;
    runtime.status.warning = percent >= config.warnThreshold;
    // Indicators go through the changed-write, measurements through the normal one.
    void this.deps.setStateChanged(`${config.id}.warning`, runtime.status.warning);
    void this.deps.setStateChanged(`${config.id}.limitReached`, percent >= 100);
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
   * Delete what this account no longer delivers.
   *
   * The first round after a start compares against the DATABASE, so a window or
   * model that disappeared while the adapter was stopped is caught as well; every
   * round after that compares against the previous snapshot, which costs nothing.
   *
   * @param runtime the account's runtime
   * @param delivered the state ids this snapshot wrote
   */
  private async removeVanished(runtime: AccountRuntime, delivered: string[]): Promise<void> {
    const known = runtime.deliveredIds ?? (await this.deps.listStateIds(runtime.config.id));
    for (const id of orphanObjectIds(known, delivered, runtime.staticIds)) {
      await this.deps.deleteObject(id);
      runtime.createdObjects.delete(id);
      this.deps.log.info(`${runtime.config.name}: removed "${id}" — the provider no longer reports it`);
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
   * Write one account's info states (offline marker, error text, last update).
   *
   * @param runtime the account's runtime
   */
  private writeAccountInfo(runtime: AccountRuntime): void {
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
  private async writeAccountStatus(runtime: AccountRuntime): Promise<void> {
    const { config } = runtime;
    const delivering = runtime.state === "ok" || runtime.state === "rate-limited";
    await Promise.all([
      this.deps.setStateChanged(`${config.id}.info.unreach`, !delivering),
      this.deps.setStateChanged(`${config.id}.info.error`, runtime.error),
    ]);
  }

  /** Recompute and write the totals + info.connection. */
  private writeTotals(): void {
    const totals = computeTotals(
      this.runtimes.map(runtime => runtime.status),
      this.configuredAccounts,
    );
    this.deps.setState("total.costs.today", totals.costsToday);
    this.deps.setState("total.costs.month", totals.costsMonth);
    this.deps.setState("total.costs.projectedMonth", totals.costsProjectedMonth);
    this.deps.setState("total.maxLimitPercent", totals.maxLimitPercent);
    this.deps.setState("total.warningsActive", totals.warningsActive);
    void this.deps.setStateChanged("total.limitReached", totals.limitReached);
    this.deps.setState("total.accountsReachable", totals.accountsReachable);
    // The configured count only ever changes with the configuration, which restarts
    // the instance — rewriting it every cycle would be pure noise in a recording.
    void this.deps.setStateChanged("total.accounts", totals.accounts);
    void this.deps.setStateChanged("info.connection", totals.accountsReachable > 0);
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
    runtime.staticIds = defs.filter(def => def.type === "state").map(def => def.id);
    // Mark it as not delivering right away, before anything has been asked.
    //
    // This looks pessimistic and is the honest state: nothing has been read yet. It
    // also carries the whole weight of "the instance was off". Whatever the previous
    // run left behind stands until someone overwrites it — after a hard kill, after
    // a crash, after an unclean shutdown the account would otherwise sit there green
    // and claim to deliver while no process exists at all. nut2 marks its devices
    // unreachable on start for exactly this reason.
    //
    // The window is short: the first poll follows within seconds and writes the real
    // state, success or failure. Only the marker — `info.error` belongs to the AI
    // service, and "we have not asked yet" is not something it said.
    void this.deps.setStateChanged(`${config.id}.info.unreach`, true);
    void this.deps.setStateChanged(`${config.id}.info.error`, REASON_UNKNOWN);
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

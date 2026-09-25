import { errorText } from "./error-text";
import { tName } from "./i18n";
import type { AccountConfig } from "./pure-helpers";
import { PROVIDER_LABELS } from "./sign-in";
import { FetchError, type UsageProvider, type UsageSnapshot } from "./provider";
import { limitingWindow, lockedWindows, mapSnapshot, orphanObjectIds, type ObjectDef } from "./snapshot-tree";
import { computeTotals, type AccountStatus } from "./totals";

/**
 * What the adapter currently knows about one account, in one word.
 *
 * `ok` and `rate-limited` mean the AI service is up and talking to us,
 * `unauthorized` means it is up but rejects our sign-in, `service-down` means the
 * service itself answered with a fault, `no-connection` means we never reached it.
 *
 * `storage-error` is about OUR side: the numbers arrived, the object database did
 * not take them. It has to stay apart from the four above — run together with
 * `network` (which is what a rejected `extendObject` used to become) the account
 * kept claiming to deliver, because the network counter is reset before every
 * fetch and therefore never reached its third strike.
 */
export type AccountState =
  "ok" | "unauthorized" | "rate-limited" | "service-down" | "no-connection" | "not-signed-in" | "storage-error";

/**
 * Whether an account is delivering usable numbers right now.
 *
 * ONE answer for the whole engine. The connection icon read it off the account's
 * state while the totals and `info.connection` read a second flag, so a first poll
 * that hit a throttle left the account green next to "0 accounts reachable".
 *
 * A throttle keeps the last values and the service is fine — that stays green; a
 * missing sign-in, a rejected one, a broken service and no connection do not.
 *
 * @param state the account's state
 * @returns true while the account counts as delivering
 */
export function isDelivering(state: AccountState): boolean {
  return state === "ok" || state === "rate-limited";
}

/**
 * Whether a failure is one a replaced sign-in can produce — and a stale round may
 * therefore drop instead of report (see {@link PollEngine.pollNow}).
 *
 * @param error the thrown value
 * @returns true for a rejected sign-in or a throttle
 */
function isStaleAnswer(error: unknown): boolean {
  return error instanceof FetchError && (error.kind === "auth" || error.kind === "rate-limit");
}

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

/** What `info.error` says for an account the adapter has no usable credential for. */
const NO_CREDENTIAL_REASON = "No API key selected — pick one in the instance settings";

/** The adapter callbacks the engine drives — narrow, so tests need no adapter mock. */
export interface EngineDeps {
  /** Create or update an object. */
  upsertObject(def: ObjectDef): Promise<void>;
  /** Delete an object and everything below it. */
  deleteObject(id: string): Promise<void>;
  /** Every state id that currently exists below `prefix` (relative to the instance). */
  listStateIds(prefix: string): Promise<string[]>;
  /**
   * Read back one of the adapter's OWN states, or null when it has no value yet.
   *
   * Used once per account at startup to learn whether the warn threshold was
   * already exceeded before this process began. A threshold crossing is a
   * TRANSITION, and a transition needs the previous state — held in memory only, a
   * restart looked like a fresh crossing and raised the warning and the
   * notification again, however long the value had already been standing.
   */
  readState(id: string): Promise<boolean | number | string | null>;
  /**
   * Write a state value with ack — for MEASUREMENTS, where every cycle carries information.
   * `null` is "no value": an announced time that is not running (decision 72).
   */
  setState(id: string, value: boolean | number | string | null): void;
  /**
   * Write a state only when the value differs from what the database holds — for
   * INDICATORS. js-controller does the comparison (`setStateChangedAsync`), which is
   * what the rest of the fleet uses; a hand-rolled cache would only know what this
   * process wrote and would still write blindly after a restart.
   *
   * Returns a promise so the shutdown path can WAIT for its writes; everywhere else
   * it is deliberately ignored — a poll cycle must not be held up by the database.
   */
  setStateChanged(id: string, value: boolean | number | string | null): Promise<void>;
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
   * Report whether an account's stored sign-in was REJECTED by the provider.
   *
   * Called on every state change of that fact, so the settings page can tell a
   * live sign-in from a token file that merely still exists. Without it the card
   * read "signed in" off file existence alone and showed a green check next to an
   * amber "Sign-in rejected" badge.
   *
   * @param accountId the account's object id
   * @param rejected true when the last query failed with `auth`
   */
  authState?(accountId: string, rejected: boolean): void;
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
  /**
   * The account's source, or null when there is none to build — a key account
   * whose credential is missing or unreadable.
   *
   * Such an account still gets its objects and its start stamp. Skipping it
   * outright left the tree of a previously working account standing with its last
   * values AND its last status, so a key that had been removed showed as online
   * for as long as nobody looked (decision 19c applies to every account, not only
   * to the ones that can be polled).
   */
  provider: UsageProvider | null;
  status: AccountStatus;
  /** Consecutive network failures. */
  failCount: number;
  /** Skip polls until this time (rate-limit backoff). */
  skipUntil: number;
  /** Current backoff length (ms). */
  backoffMs: number;
  /** Whether the auth-broken notification has been raised (reset on success). */
  authNotified: boolean;
  /**
   * Whether the last write of a fetched snapshot was rejected by the object
   * database — carries the log de-duplication (warn once, debug on repeat; the
   * fleet keys such a guard on the CATEGORY, not on the message).
   */
  storageFailed: boolean;
  /**
   * Whether the last orphan sweep was rejected by the object database — its own
   * de-duplication, because it is a different category than a failed value write:
   * the values DID reach the tree, only the cleanup did not run.
   */
  sweepFailed: boolean;
  /** Whether the last query was rejected as unauthorized — reported to the sign-in card. */
  authRejected: boolean;
  /** Whether a plan-wide window was reported as CLOSED by the provider on the last answer. */
  locked: boolean;
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
  /**
   * Whether this account DELIVERED in this process — a snapshot reached the tree.
   *
   * `firstPollDone` is also true after a first round that failed, so it cannot say
   * whether the previous side of a transition was observed (decision 50/64): a lock
   * reported on the first delivery after a failed start is a transition nobody saw.
   */
  deliveredOnce: boolean;
  /**
   * The failure category the log last WARNED about, or null.
   *
   * The fleet de-duplicates on the category: the first failure of a kind is one
   * warn, every repeat is debug. It starts at null — the previous stand-in,
   * `serviceOnline === false`, is also what a fresh process starts with, so a fault
   * in the first round of a process was never logged at all. A network outage never
   * lands here: offline is a state the datapoints carry, not a log line.
   */
  loggedCategory: "service" | "unprocessable" | "rate-limit" | "auth" | "storage" | null;
  /**
   * Bumped by {@link PollEngine.pollNow}. A round remembers the generation it started
   * in; a rejection or throttle from an OLDER generation belongs to the sign-in that
   * was just replaced and is dropped instead of reported.
   */
  generation: number;
  /** Whether the account's static objects exist — a failed skeleton is retried by the next poll. */
  skeletonReady: boolean;
  /** Whether the account's poll timers are armed (a provider can arrive later, decision 88). */
  armed: boolean;
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
   * @param reasons why an account has no provider, per account id — the adapter knows
   *   whether no key was selected, the selected entry is gone, or it carries no key
   */
  public constructor(
    accounts: readonly AccountConfig[],
    providers: ReadonlyMap<string, UsageProvider>,
    private readonly intervalSec: number,
    private readonly deps: EngineDeps,
    reasons: ReadonlyMap<string, string> = new Map(),
  ) {
    this.configuredAccounts = accounts.length;
    for (const config of accounts) {
      const provider = providers.get(config.id) ?? null;
      if (!provider) {
        // No warning here: the adapter already said which credential it could not
        // read, with the reason. A second line would only repeat it.
        deps.log.debug(`${config.name}: no usable credential — the account is shown as not delivering`);
      }
      this.runtimes.push({
        config,
        provider,
        status: { reachable: false, warning: false },
        failCount: 0,
        skipUntil: 0,
        backoffMs: BACKOFF_START_MS,
        authNotified: false,
        authRejected: false,
        storageFailed: false,
        sweepFailed: false,
        serviceOnline: false,
        state: provider ? "no-connection" : "not-signed-in",
        // Nothing known until the service says something; the skeleton writes
        // REASON_UNKNOWN, and the first answer replaces it. An account without a
        // credential has its answer already.
        error: provider ? REASON_UNKNOWN : (reasons.get(config.id) ?? NO_CREDENTIAL_REASON),
        locked: false,
        createdObjects: new Set(),
        firstPollDone: false,
        deliveredOnce: false,
        loggedCategory: null,
        generation: 0,
        skeletonReady: false,
        armed: false,
        polling: false,
        pollAgain: false,
        deliveredIds: null,
        staticIds: [],
      });
    }
  }

  /** Create the static per-account and totals objects, then arm the poll cycles. */
  public async start(): Promise<void> {
    // Decision 69 inside the engine: a shutdown that lands in the skeleton's waits
    // must not let the start run on — it would overwrite the "Unknown" that
    // `markAllOffline()` just wrote and arm timers the host refuses. The skeleton
    // checks before every object it creates, so a stopped engine passes the
    // remaining accounts without a single write.
    for (const runtime of this.runtimes) {
      await this.createAccountSkeletonSafe(runtime);
    }
    if (this.stopped) {
      return;
    }
    try {
      await this.createTotalsSkeleton();
    } catch (e) {
      // The totals are written again after every poll; a missing object here costs
      // their values until the database takes them, never the polling itself.
      this.deps.log.warn(`The totals could not be created — the object database rejected them (${errorText(e)})`);
    }
    if (this.stopped) {
      return;
    }
    if (this.runtimes.length === 0) {
      // Nothing will ever poll. Report first — that is what releases the totals
      // derived from snapshots — and then write them: with no account, all of them
      // are zero, which is exactly what a user who switched everything off must see.
      this.reportFirstRoundOnce();
      return;
    }
    // The counts only; what the snapshots decide waits for the first round (decision 74).
    this.writeTotals();
    this.runtimes.forEach((runtime, index) => {
      if (!runtime.provider) {
        // Nothing to ask. The skeleton above has already said so; count it as
        // been-through so it cannot hold the first-round report back for ever.
        runtime.firstPollDone = true;
        this.reportFirstRoundOnce();
        return;
      }
      this.arm(runtime, index * STAGGER_MS);
    });
  }

  /**
   * Arm one account's poll cycle: a staggered first poll that then arms the repeating timer.
   *
   * The repeating timer is armed INSIDE the staggered first poll, not next to it:
   * armed together they would all count from the same instant, and from the second
   * round on every account would fire at once — exactly the burst the stagger exists
   * to prevent, against providers that answer a burst by locking the account.
   *
   * @param runtime the account's runtime
   * @param delayMs the stagger before the first poll
   */
  private arm(runtime: AccountRuntime, delayMs: number): void {
    runtime.armed = true;
    this.handles.push(
      this.deps.scheduleOnce(() => {
        if (this.stopped) {
          return;
        }
        this.handles.push(this.deps.schedule(() => void this.pollAccount(runtime, false), this.intervalSec * 1000));
        void this.pollAccount(runtime, false);
      }, delayMs),
    );
  }

  /**
   * Swap an account's source while the adapter runs — the credential in the admin's
   * central storage was edited or deleted.
   *
   * Without it the key was read once at startup: a key replaced after a leak kept
   * being sent until the next restart, and a deleted one left the account's alarms
   * standing for ever, because a key account without a provider is never polled
   * and never reaches the transition that clears them (decision 61, second half).
   *
   * @param accountId the account's object id
   * @param provider the new source, or null when the credential is gone or unusable
   * @param reason why there is no source — shown in `info.error`
   */
  public async setProvider(accountId: string, provider: UsageProvider | null, reason?: string): Promise<void> {
    const runtime = this.runtimes.find(entry => entry.config.id === accountId);
    if (!runtime || this.stopped) {
      return;
    }
    runtime.provider = provider;
    if (!provider) {
      runtime.generation++;
      this.retireAlarms(runtime);
      runtime.state = "not-signed-in";
      runtime.error = reason ?? NO_CREDENTIAL_REASON;
      runtime.status.reachable = false;
      void this.writeAccountStatus(runtime);
      this.writeTotals();
      return;
    }
    if (!runtime.armed) {
      this.arm(runtime, 0);
      return;
    }
    await this.pollNow(accountId);
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
   * `info.error` goes back to {@link REASON_UNKNOWN}: while the instance is off the
   * adapter has nothing to report, and the fleet-wide word for that is the single
   * word "Unknown" (krobi 2026-08-27) — never a stale provider message, never an
   * invented sentence about our own operating state.
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
      // A fresh sign-in clears a previous auth failure and any backoff. A round still
      // in flight belongs to the sign-in that was just replaced: the new generation
      // makes its rejection or throttle a stale answer, not a new report (decision 77).
      runtime.generation++;
      runtime.authNotified = false;
      runtime.authRejected = false;
      runtime.skipUntil = 0;
      await this.pollAccount(runtime, true);
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
   * A timer tick that lands on a running round is dropped instead: it is no request
   * anyone is waiting for, and remembering it made the next round start the moment
   * the current one ended — no pause at all against a provider that may throttle
   * (decision 78).
   *
   * @param runtime the account's runtime
   * @param requested true for a poll someone asked for (sign-in, sign-out, new key)
   */
  private async pollAccount(runtime: AccountRuntime, requested: boolean): Promise<void> {
    if (this.stopped || !runtime.provider) {
      return;
    }
    if (runtime.polling) {
      if (requested) {
        runtime.pollAgain = true;
      } else {
        this.deps.log.debug(`${runtime.config.name}: the previous poll is still running — this tick is skipped`);
      }
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
      await this.pollAccount(runtime, true);
    }
  }

  /**
   * One poll of one account: fetch, classify, write.
   *
   * @param runtime the account's runtime
   */
  private async pollOnce(runtime: AccountRuntime): Promise<void> {
    const { config } = runtime;
    // Taken BEFORE the request: a backoff counted from the answer's arrival put the
    // tick that lands exactly on its end a few hundred milliseconds too early, and
    // every wait grew by one full interval (decision 79).
    const roundStart = this.deps.now();
    if (roundStart < runtime.skipUntil) {
      this.deps.log.debug(`${config.name}: in rate-limit backoff — poll skipped`);
      // Still counts as "been through": otherwise an account that starts inside a
      // backoff would hold the first-round report back forever.
      runtime.firstPollDone = true;
      this.reportFirstRoundOnce();
      return;
    }
    if (!runtime.skeletonReady) {
      await this.createAccountSkeletonSafe(runtime);
      if (this.stopped) {
        return;
      }
      if (!runtime.skeletonReady) {
        runtime.firstPollDone = true;
        this.reportFirstRoundOnce();
        return;
      }
    }
    const generation = runtime.generation;
    // Did THIS round bring values into the tree? The retained `state` cannot answer
    // that: a tolerated network failure leaves it on "ok" until the third strike,
    // so the stamp used to move for a round that fetched nothing (decision 43, the
    // half that was still open).
    let delivered = false;
    let fetched: UsageSnapshot | undefined;
    try {
      fetched = await (runtime.provider as UsageProvider).fetch();
      // The answer can arrive AFTER onUnload: `stop()` cancels the timers, it
      // cannot cancel a request already in flight. Writing now would undo
      // `markAllOffline()` and leave a stopped adapter claiming the account is
      // online — the exact state decision 19 exists to prevent.
      if (this.stopped) {
        return;
      }
      runtime.failCount = 0;
      runtime.backoffMs = BACKOFF_START_MS;
      runtime.authNotified = false;
      runtime.serviceOnline = true;
      runtime.state = "ok";
      runtime.error = "";
      if (runtime.authRejected) {
        runtime.authRejected = false;
        this.deps.authState?.(config.id, false);
      }
    } catch (e) {
      if (this.stopped) {
        return;
      }
      if (generation !== runtime.generation && isStaleAnswer(e)) {
        // The sign-in this round started with has just been replaced; its rejection
        // or throttle says nothing about the new one, which runs right after.
        this.deps.log.debug(`${config.name}: dropped a stale answer from before the new sign-in (${errorText(e)})`);
        return;
      }
      this.handleFailure(runtime, e, roundStart);
    }
    if (fetched !== undefined) {
      // The WRITE path has its own guard. Inside the fetch `try` a rejected
      // `extendObject` or `getObjectViewAsync` arrived at `handleFailure` and was
      // filed as a network error — but `failCount` is reset above before every
      // fetch, so the third strike never came: the account stayed green, the
      // last-update stamp kept moving, and the only trace was a debug line.
      try {
        await this.applySnapshot(runtime, fetched);
        if (this.stopped) {
          return;
        }
        // Only now: the totals must not run ahead of the tree they claim to sum.
        runtime.status.snapshot = fetched;
        runtime.status.fetchedAt = this.deps.now();
        runtime.status.limitReachedSeed = false;
        runtime.storageFailed = false;
        runtime.deliveredOnce = true;
        delivered = true;
        if (runtime.loggedCategory !== null) {
          // The failure said so in the log; the recovery has to as well, or the last
          // word on this account stays a warning that is no longer true. Only where
          // a warning WAS written: a start, a first sign-in or a network outage left
          // none, and "delivering again" after silence announces a recovery from a
          // failure nobody was told about (decisions 64 and 76).
          this.deps.log.info(`${config.name}: delivering again`);
          runtime.loggedCategory = null;
        }
      } catch (e) {
        if (this.stopped) {
          return;
        }
        this.handleStorageFailure(runtime, e);
      }
    }
    runtime.status.reachable = isDelivering(runtime.state);
    this.writeAccountInfo(runtime, delivered);
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
    // Every account has been through once: the totals derived from snapshots are
    // now a statement about all of them, not about whoever answered first.
    this.writeTotals();
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
      // Checked per object, not once after the loop: a shutdown in the middle of a
      // long first creation must not let the remaining upserts run on (decision 47).
      if (this.stopped) {
        return;
      }
      if (!runtime.createdObjects.has(object.id)) {
        await this.deps.upsertObject(object);
        runtime.createdObjects.add(object.id);
      }
    }
    // Decision 32 applies to EVERY await of the poll path, not only to the fetch.
    // Creating the objects waits on the database, and a shutdown that lands in
    // that wait used to let the round run to its end afterwards — writing values
    // and then `unreach = false` on top of the offline stamp `markAllOffline()`
    // had already set, after the host had been told the adapter was done.
    if (this.stopped) {
      return;
    }
    for (const write of writes) {
      // Announced facts through the comparing write, measurements through the plain
      // one — the fleet rule, decided at the ROLE the tree builder already carries.
      if (write.compare) {
        void this.deps.setStateChanged(write.id, write.value);
      } else {
        this.deps.setState(write.id, write.value);
      }
    }
    // The sweep is MAINTENANCE, not storage. Letting its failure reject the whole
    // round made the account report "values fetched but not stored" while the
    // values were demonstrably in the tree — and `status.snapshot` stayed on the
    // previous answer, so `total.*` froze while the account's own datapoints moved
    // on. Two datapoints of one adapter contradicting each other about one fact.
    try {
      await this.removeVanished(
        runtime,
        writes.map(write => write.id),
      );
      runtime.sweepFailed = false;
    } catch (e) {
      this.handleSweepFailure(runtime, e);
    }
    if (this.stopped) {
      return;
    }
    // Only PLAN-WIDE windows speak for the account — a per-model bucket at 100 %
    // must not read as "this AI is full" (krobi 2026-08-26, again 2026-09-06:
    // "Fable at 100 % is the Fable limit, but neither the 5 h limit nor the weekly
    // limit").
    const driver = limitingWindow(snapshot);
    const percent = driver?.percent ?? 0;
    const wasWarning = runtime.status.warning;
    runtime.status.warning = percent >= config.warnThreshold;
    // A provider that CLOSED a plan-wide window has said outright what the
    // percentage only implies. Both count.
    const locked = lockedWindows(snapshot);
    // Only once this process has SEEN the account deliver. Being locked has no
    // datapoint of its own (decision 36 — it feeds `limitReached` and this line), so
    // the first delivery has nothing to compare against — also when it comes after a
    // failed first round: reporting a transition there claims an event nobody
    // observed (decision 75).
    if (locked.length > 0 && !runtime.locked && runtime.deliveredOnce) {
      this.deps.log.warn(`${config.name}: ${locked[0].label} is locked by the provider — ${locked[0].reason}`);
    }
    runtime.locked = locked.length > 0;
    // Indicators go through the changed-write, measurements through the normal one.
    void this.deps.setStateChanged(`${config.id}.warning`, runtime.status.warning);
    void this.deps.setStateChanged(`${config.id}.limitReached`, percent >= 100 || runtime.locked);
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
    // The view of the first round waits on the database; a shutdown in that wait must
    // not be followed by zeroed models and deleted objects (decision 47, the sweep).
    if (this.stopped) {
      return;
    }
    const reported = this.zeroUnusedModels(known, delivered);
    for (const id of orphanObjectIds(known, reported, runtime.staticIds)) {
      if (this.stopped) {
        return;
      }
      await this.deps.deleteObject(id);
      runtime.createdObjects.delete(id);
      this.deps.log.info(`${runtime.config.name}: removed "${id}" — the provider no longer reports it`);
    }
    runtime.deliveredIds = reported;
  }

  /**
   * A model the report does not mention this round is IDLE, not gone — write its 0.
   *
   * The usage report is a statement about a PERIOD, not an inventory: a model is
   * missing from it because nothing ran on it, not because the provider dropped it.
   * The sweep cannot tell those apart, so it used to delete on the weaker reading.
   *
   * Decision 49 closed the daily half of this — the OpenAI model list is built from
   * the whole month, so UTC midnight no longer empties it. The MONTH boundary was
   * the half left open: the report starts over on the 1st, and the moment the first
   * model of the new month reports usage, every other model's channel was swept —
   * history, enum membership and all — and re-created on its next use.
   *
   * Writing the 0 fixes both halves at once. The channel stays (it is in the
   * delivered set, so {@link orphanObjectIds} leaves it alone) and it stops lying:
   * without this, an unreported model would simply freeze on its last count under a
   * name that says "today" — the exact lie decision 49 removed from the block as a
   * whole. `limits.*` keeps the old reading, and rightly so: there the provider
   * reports the PLAN, so a window that stops appearing really is gone.
   *
   * @param known every state id the account had before
   * @param delivered the state ids this snapshot wrote
   * @returns `delivered` plus the idle model states, which now carry a written 0
   */
  private zeroUnusedModels(known: readonly string[], delivered: string[]): string[] {
    const delivering = new Set(delivered);
    const idle: string[] = [];
    for (const id of known) {
      if (delivering.has(id)) {
        continue;
      }
      // `<account>.models.<model>.tokensToday` — the only state a model channel
      // carries. Named explicitly rather than zeroing everything under `models.`:
      // a future non-numeric state there must not silently receive a 0.
      const parts = id.split(".");
      if (parts.length === 4 && parts[1] === "models" && parts[3] === "tokensToday") {
        this.deps.setState(id, 0);
        idle.push(id);
      }
    }
    return idle.length > 0 ? [...delivered, ...idle] : delivered;
  }

  /**
   * The numbers arrived, the object database did not take them.
   *
   * Not a provider failure: the service answered, so `serviceOnline` stays true and
   * the network counter is untouched. What is broken is our own side, and the
   * account is not delivering while it lasts — the tree is frozen on old values.
   *
   * The log is de-duplicated on the CATEGORY, not on the message (fleet rule): one
   * warn naming the likely cause, debug for every repeat. A database that stays
   * down would otherwise write a warning every poll interval.
   *
   * @param runtime the account's runtime
   * @param error the thrown error
   */
  private handleStorageFailure(runtime: AccountRuntime, error: unknown): void {
    const message = errorText(error);
    runtime.state = "storage-error";
    runtime.error = `Values fetched but not stored — the object database rejected the write (${message})`;
    if (runtime.storageFailed) {
      this.deps.log.debug(`${runtime.config.name}: the object database still rejects the write (${message})`);
      return;
    }
    runtime.storageFailed = true;
    runtime.loggedCategory = "storage";
    this.deps.log.warn(
      `${runtime.config.name}: the values were fetched but could not be stored — the object database rejected the write (${message})`,
    );
  }

  /**
   * The values are in the tree, the cleanup did not run.
   *
   * Not a storage failure: nothing the provider delivered was lost, so the round
   * counts as delivered and the snapshot is adopted. What did not happen is the
   * removal of a window or model the provider no longer reports — it retries next
   * round, because `deliveredIds` is left untouched and the first round after a
   * start compares against the DATABASE by design.
   *
   * @param runtime the account's runtime
   * @param error the thrown error
   */
  private handleSweepFailure(runtime: AccountRuntime, error: unknown): void {
    const message = errorText(error);
    if (runtime.sweepFailed) {
      this.deps.log.debug(`${runtime.config.name}: the cleanup of vanished entries still fails (${message})`);
      return;
    }
    runtime.sweepFailed = true;
    this.deps.log.warn(
      `${runtime.config.name}: the values were stored, but vanished entries could not be cleaned up (${message})`,
    );
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
   * @param roundStart when this round began (ms) — the backoff counts from here
   */
  private handleFailure(runtime: AccountRuntime, error: unknown, roundStart: number): void {
    const { config } = runtime;
    const message = errorText(error);
    if (error instanceof FetchError && error.kind === "no-credentials") {
      // Nobody has signed in yet, or the key is gone. That is not a rejected
      // sign-in: no notification, no warning, and the settings page keeps
      // offering the sign-in button instead of an error.
      // The service answered us in the sense that matters here — nothing about the
      // connection is broken — so the network strike counter starts over.
      runtime.failCount = 0;
      runtime.serviceOnline = true;
      if (runtime.state !== "not-signed-in") {
        // ON THE TRANSITION only. A deliberate sign-out means the account is no
        // longer watched: its VALUES stay (decision 6/15), but its ALARMS must not.
        // Only the subscriptions arrive here; a key that vanished from the credential
        // store reaches the same retirement through `setProvider` and the skeleton.
        this.retireAlarms(runtime);
      }
      runtime.state = "not-signed-in";
      runtime.error = message;
      if (!runtime.authNotified) {
        runtime.authNotified = true;
        this.deps.log.info(`${config.name}: ${message}`);
      }
      return;
    }
    if (error instanceof FetchError && error.kind === "auth") {
      // The service ANSWERED — it only said no. Whatever network strikes stood
      // before are stale (decision 11).
      runtime.failCount = 0;
      runtime.serviceOnline = true;
      runtime.state = "unauthorized";
      runtime.error = `Sign-in rejected — ${message}`;
      if (!runtime.authRejected) {
        runtime.authRejected = true;
        this.deps.authState?.(config.id, true);
      }
      if (!runtime.authNotified) {
        runtime.authNotified = true;
        runtime.loggedCategory = "auth";
        const text = `${config.name}: credentials rejected — ${message}`;
        this.deps.log.warn(text);
        this.deps.notify?.(config.name, text);
      }
      return;
    }

    if (error instanceof FetchError && error.kind === "rate-limit") {
      // Answered as well — a throttle is a reply, not a lost connection.
      runtime.failCount = 0;
      runtime.serviceOnline = true;
      runtime.state = "rate-limited";
      // The provider's own wait wins when it asks for longer than our backoff.
      const waitMs = Math.max(runtime.backoffMs, error.retryAfterMs ?? 0);
      const minutes = Math.max(1, Math.round(waitMs / 60000));
      runtime.error = `Throttled by the provider — retrying in about ${minutes} min, last values kept`;
      runtime.skipUntil = roundStart + waitMs;
      this.logFailure(
        runtime,
        "rate-limit",
        `${config.name}: rate-limited — backing off for about ${minutes} min, keeping last values`,
      );
      runtime.backoffMs = Math.min(BACKOFF_MAX_MS, runtime.backoffMs * 2);
      return;
    }
    if (error instanceof FetchError && error.kind === "service") {
      runtime.failCount = 0;
      this.logFailure(runtime, "service", `${config.name}: the service reports a fault (${message}) — values kept`);
      runtime.serviceOnline = false;
      runtime.state = "service-down";
      runtime.error = `The AI service reports a fault — ${message}`;
      return;
    }
    if (!(error instanceof FetchError)) {
      // Decision 21 one level down: an answer that arrived but could not be turned
      // into a snapshot is a fault, not a lost connection. Filed as a network
      // failure it spent two rounds in `debug` and then claimed "not reachable" —
      // the one thing that was certainly not the case.
      runtime.failCount = 0;
      this.logFailure(
        runtime,
        "unprocessable",
        `${config.name}: the answer could not be processed (${message}) — values kept`,
      );
      runtime.serviceOnline = false;
      runtime.state = "service-down";
      runtime.error = `The answer could not be processed — ${message}`;
      return;
    }
    runtime.failCount++;
    this.deps.log.debug(`${config.name}: fetch failed (${message}), attempt ${runtime.failCount}`);
    if (runtime.failCount >= MAX_NETWORK_FAILURES) {
      // Debug, not warn: offline is a STATE, and `info.unreach`/`info.error` carry it
      // (fleet rule 2026-09-22). A log line here only repeats the datapoint.
      if (runtime.serviceOnline) {
        this.deps.log.debug(`${config.name}: not reachable after ${runtime.failCount} attempts (${message})`);
      }
      runtime.serviceOnline = false;
      runtime.state = "no-connection";
      runtime.error = `Not reachable after ${runtime.failCount} attempts — ${message}`;
    }
  }

  /**
   * Log a failure once per category: warn on the first, debug on every repeat.
   *
   * @param runtime the account's runtime
   * @param category what kind of failure this is
   * @param text the log line
   */
  private logFailure(
    runtime: AccountRuntime,
    category: "service" | "unprocessable" | "rate-limit",
    text: string,
  ): void {
    if (runtime.loggedCategory === category) {
      this.deps.log.debug(text);
      return;
    }
    runtime.loggedCategory = category;
    this.deps.log.warn(text);
  }

  /**
   * Take an account out of every alarm and every sum — it is no longer watched.
   *
   * Measured (decision 61): an account signed out at 100 % held `warning`,
   * `limitReached`, `total.warningsActive`, `total.maxLimitPercent` and
   * `total.limitReached` until someone signed in again — an automation waiting on
   * them never moved. `computeTotals` skips an account without a snapshot, so dropping
   * it removes the account from every sum at once. Its VALUES stay (decision 6/15).
   *
   * @param runtime the account's runtime
   */
  private retireAlarms(runtime: AccountRuntime): void {
    const { config } = runtime;
    runtime.status.snapshot = undefined;
    runtime.status.warning = false;
    runtime.status.limitReachedSeed = false;
    runtime.locked = false;
    void this.deps.setStateChanged(`${config.id}.warning`, false);
    void this.deps.setStateChanged(`${config.id}.limitReached`, false);
  }

  /**
   * Write one account's info states (offline marker, error text, last update).
   *
   * The stamp only moves when a poll actually brought a snapshot. It used to hang
   * on `reachable`, and that includes `rate-limited` by design — so every throttled
   * poll re-dated values it had not fetched: after a day of throttling the stamp
   * read "an hour ago" next to day-old numbers, which is the one thing a datapoint
   * called "last successful update" must never do (measured 2026-09-07 while
   * writing its description).
   *
   * It hung on `runtime.state === "ok"` alone, and the network branch only sets the
   * state on the THIRD strike — so the first two tolerated failures left the state
   * on "ok" and re-dated values the round had never fetched. The caller now says
   * whether this round actually brought a snapshot into the tree.
   *
   * @param runtime the account's runtime
   * @param delivered whether this round wrote a fetched snapshot
   */
  private writeAccountInfo(runtime: AccountRuntime, delivered: boolean): void {
    const { config } = runtime;
    void this.writeAccountStatus(runtime);
    if (delivered) {
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
    try {
      const delivering = isDelivering(runtime.state);
      await Promise.all([
        this.deps.setStateChanged(`${config.id}.info.unreach`, !delivering),
        this.deps.setStateChanged(`${config.id}.info.error`, runtime.error),
      ]);
    } catch (e) {
      // Dropped with `void` by the caller: a rejection here would be unhandled and
      // end the instance. The states database going down is logged, not fatal.
      this.deps.log.debug(`${config.name}: could not write the status (${errorText(e)})`);
    }
  }

  /**
   * Recompute and write the totals + info.connection.
   *
   * The sums that come out of SNAPSHOTS wait until every account has been through
   * its first poll (decision 74). Written at start they were computed from nothing:
   * every restart dropped `total.limitReached`, `total.maxLimitPercent` and the costs
   * to 0 for a moment — a real change of value, a false flank for every automation —
   * and the accounts then came back one by one as their staggered polls answered.
   */
  private writeTotals(): void {
    // No stop check of its own: every caller checks right before, with no wait in
    // between — a guard here could never be the one that holds.
    const totals = computeTotals(
      this.runtimes.map(runtime => runtime.status),
      this.configuredAccounts,
      this.deps.now(),
    );
    // Every total goes through the changed-write. They are recomputed after EVERY
    // account's poll — with several accounts that meant one write per account per
    // round, almost always of the value that was already there. What they say only
    // changes when an account's numbers change, and then the write happens.
    if (this.firstRoundReported) {
      void this.deps.setStateChanged("total.costs.today", totals.costsToday);
      void this.deps.setStateChanged("total.costs.month", totals.costsMonth);
      void this.deps.setStateChanged("total.costs.projectedMonth", totals.costsProjectedMonth);
      void this.deps.setStateChanged("total.maxLimitPercent", totals.maxLimitPercent);
      void this.deps.setStateChanged("total.warningsActive", totals.warningsActive);
      void this.deps.setStateChanged("total.limitReached", totals.limitReached);
    }
    void this.deps.setStateChanged("total.accountsReachable", totals.accountsReachable);
    // The configured count only ever changes with the configuration, which restarts
    // the instance — rewriting it every cycle would be pure noise in a recording.
    void this.deps.setStateChanged("total.accounts", totals.accounts);
    void this.deps.setStateChanged("info.connection", totals.accountsReachable > 0);
  }

  /**
   * Create the skeleton, and survive a database that refuses it.
   *
   * One rejected upsert used to throw out of `start()` before a single timer was
   * armed: "Startup failed", and the process ran on without ever polling again. The
   * failure is now the account's alone, logged once, and the next poll retries it.
   *
   * @param runtime the account's runtime
   */
  private async createAccountSkeletonSafe(runtime: AccountRuntime): Promise<void> {
    try {
      await this.createAccountSkeleton(runtime);
      runtime.skeletonReady = !this.stopped;
    } catch (e) {
      const message = errorText(e);
      if (runtime.storageFailed) {
        this.deps.log.debug(`${runtime.config.name}: the account's objects still cannot be created (${message})`);
        return;
      }
      runtime.storageFailed = true;
      this.deps.log.warn(
        `${runtime.config.name}: the account's objects could not be created — the object database rejected them (${message}); retrying with the next poll`,
      );
    }
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
          // The readable provider name, never the internal kind: the node used to
          // read "Claude (claude-sub)" and "My key (anthropic-api)" in the tree.
          //
          // The bracket stays even when it repeats the name ("Claude (Claude)") —
          // krobi decided that on 2026-09-06 after seeing that the repetition is
          // the normal case (the settings page names a subscription row after its
          // provider, and a key account inherits the name of its credential entry).
          // The provider is then always visible, including for a freely named
          // access ("Arbeitskonto (OpenRouter)"). Do not propose dropping it again.
          name: `${config.name} (${PROVIDER_LABELS[config.provider] ?? config.provider})`,
          // The admin's object tree draws its connection icon from this link and
          // from nothing else — govee, beszel, homewizard and nut2 all do the same.
          statusStates: { offlineId: "info.unreach" },
        },
      },
      { id: `${config.id}.info`, type: "channel", common: { name: tName("nameAccountInfo") } },
      {
        // The two slots ioBroker itself provides for this — measured against
        // @iobroker/type-detector 6.0.0: `unreach` is the offline marker every
        // device type carries (`indicator.reachable` is deprecated there), and
        // `indicator.error` is the standard home for the reason.
        id: `${config.id}.info.unreach`,
        type: "state",
        common: {
          name: tName("nameUnreach"),
          desc: tName("descUnreach"),
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
        common: {
          name: tName("nameLastError"),
          desc: tName("descLastError"),
          type: "string",
          role: "text",
          read: true,
          write: false,
        },
      },
      {
        id: `${config.id}.info.lastUpdate`,
        type: "state",
        common: {
          name: tName("nameLastUpdate"),
          desc: tName("descLastUpdate"),
          type: "string",
          role: "date",
          read: true,
          write: false,
        },
      },
      {
        id: `${config.id}.warning`,
        type: "state",
        common: {
          name: tName("nameWarning"),
          desc: tName("descWarning"),
          type: "boolean",
          role: "indicator",
          read: true,
          write: false,
        },
      },
      {
        id: `${config.id}.limitReached`,
        type: "state",
        common: {
          name: tName("nameLimitReached"),
          desc: tName("descLimitReached"),
          type: "boolean",
          role: "indicator",
          read: true,
          write: false,
        },
      },
    ];
    for (const def of defs) {
      if (this.stopped) {
        return;
      }
      await this.deps.upsertObject(def);
      runtime.createdObjects.add(def.id);
    }
    if (this.stopped) {
      return;
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
    // REASON_UNKNOWN while nothing has been asked yet — but an account without a
    // usable credential has its answer already, and repeating "Unknown" there
    // would hide it.
    void this.deps.setStateChanged(`${config.id}.info.error`, runtime.error);
    if (!runtime.provider) {
      // An account the adapter cannot poll is not watched — a key that was removed
      // from the credential store, or never selected. Seeding its alarms from the
      // database left them standing for ever: it never reaches a poll and therefore
      // never the transition that clears them (decision 61, the startup half).
      this.retireAlarms(runtime);
      return;
    }
    // Where the threshold stood BEFORE this process. A crossing is a transition,
    // and the previous side of it lives in the adapter's own datapoint — the only
    // place that survives a restart. Held in memory alone, every start of the
    // instance looked like a fresh crossing and raised the warning and the
    // ioBroker notification again, however long the value had been standing; a
    // config change alone restarts the instance. Missing value (fresh install, the
    // user deleted it) reads as false, which is exactly the old behaviour.
    try {
      runtime.status.warning = (await this.deps.readState(`${config.id}.warning`)) === true;
      // The same for `limitReached`, with the same rule in the sum (decision 74): it
      // counts in `total.limitReached` until this process has a snapshot of the
      // account. Without it a first round that failed flipped the total to false
      // while the account's own datapoint still said true.
      runtime.status.limitReachedSeed = (await this.deps.readState(`${config.id}.limitReached`)) === true;
    } catch (e) {
      this.deps.log.debug(`${config.name}: could not read the previous warning state (${errorText(e)})`);
    }
  }

  /** The totals skeleton (channel + states). */
  private async createTotalsSkeleton(): Promise<void> {
    const defs: ObjectDef[] = [
      { id: "total.costs", type: "channel", common: { name: tName("nameTotalCosts") } },
      {
        id: "total.costs.today",
        type: "state",
        common: {
          name: tName("nameTotalCostsToday"),
          desc: tName("descTotalCosts"),
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
          name: tName("nameTotalCostsMonth"),
          desc: tName("descTotalCosts"),
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
          name: tName("nameTotalCostsProjected"),
          desc: tName("descTotalCostsProjected"),
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
          // NOT "plan-wide utilisation": the value is whatever speaks for an
          // account (fullest plan-wide window OR its granted budget, see
          // limitingWindow) — the old name promised something narrower than the
          // number ever was.
          name: tName("nameTotalMaxPercent"),
          desc: tName("descTotalMaxPercent"),
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
          name: tName("nameTotalWarnings"),
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
          name: tName("nameTotalLimitReached"),
          desc: tName("descLimitReached"),
          type: "boolean",
          role: "indicator",
          read: true,
          write: false,
        },
      },
      {
        id: "total.accountsReachable",
        type: "state",
        common: {
          name: tName("nameTotalReachable"),
          desc: tName("descTotalReachable"),
          type: "number",
          role: "value",
          read: true,
          write: false,
        },
      },
      {
        id: "total.accounts",
        type: "state",
        common: {
          name: tName("nameTotalAccounts"),
          desc: tName("descTotalAccounts"),
          type: "number",
          role: "value",
          read: true,
          write: false,
        },
      },
    ];
    for (const def of defs) {
      await this.deps.upsertObject(def);
    }
  }
}

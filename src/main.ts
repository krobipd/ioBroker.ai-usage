import * as utils from "@iobroker/adapter-core";
import { Credentials } from "@iobroker/adapter-core";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { postForm, postJson } from "./lib/http";
import { PollEngine } from "./lib/poll-engine";
import {
  clampPollInterval,
  datapointBalanceLine,
  parseAccounts,
  SUBSCRIPTION_IDS,
  type AccountConfig,
} from "./lib/pure-helpers";
import type { TokenSet, TokenStore, UsageProvider } from "./lib/provider";
import { SIGN_IN_FLOWS, SIGN_IN_LABELS, attemptExpired, type SignInState } from "./lib/sign-in";
import { buildAuthorizeUrl, exchangeCode, generatePkce, type PkcePair } from "./lib/providers/claude-auth";
import { claudeSubProvider } from "./lib/providers/claude-sub";
import {
  CHATGPT_OAUTH,
  exchangeDeviceCode,
  pollDeviceCode,
  startDeviceCode,
  type DeviceCodeStart,
} from "./lib/providers/chatgpt-auth";
import { chatgptSubProvider } from "./lib/providers/chatgpt-sub";
import {
  buildGeminiAuthorizeUrl,
  exchangeGeminiCode,
  extractGeminiCode,
  generateGeminiPkce,
  type GeminiPkce,
} from "./lib/providers/gemini-auth";
import { geminiSubProvider } from "./lib/providers/gemini-sub";
import { anthropicApiProvider } from "./lib/providers/anthropic-api";
import { deepSeekProvider } from "./lib/providers/deepseek";
import { openAiProvider } from "./lib/providers/openai";
import { openRouterProvider } from "./lib/providers/openrouter";

/** A cancellable handle: interval or timeout — the engine treats them uniformly. */
type TimerHandle =
  | { kind: "interval"; handle: ioBroker.Interval | undefined }
  | { kind: "timeout"; handle: ioBroker.Timeout | undefined };

/** One running sign-in attempt (secrets live in memory only, never on disk). */
type Attempt =
  | { flow: "paste-code"; pkce: PkcePair; url: string; expiresAt: number }
  | { flow: "paste-url"; pkce: GeminiPkce; url: string; expiresAt: number }
  | { flow: "device-code"; start: DeviceCodeStart };

/**
 * AI Usage adapter — reads usage windows, credits and costs of AI accounts into
 * read-only states. Three subscriptions sign in with the user's own account
 * (Claude, ChatGPT, Google), the other accounts use a key from the admin's central
 * credential storage. Orchestration lives in the unit-tested {@link PollEngine};
 * this class wires ioBroker IO, the sign-in flows and the token files to it.
 */
export class AiUsageAdapter extends utils.Adapter {
  private engine: PollEngine | null = null;
  /** Running sign-in attempts, keyed by provider kind. */
  private readonly attempts = new Map<string, Attempt>();
  /** Last failure reason per provider, shown in the admin row. */
  private readonly signInErrors = new Map<string, string>();
  /** Device-code pollers, so they can be stopped on unload. */
  private readonly devicePollers = new Map<string, TimerHandle>();
  /** One token store per subscription — see {@link tokenStore} for why it is shared. */
  private readonly tokenStores = new Map<string, TokenStore>();

  /**
   * Every state id that already existed when this process started.
   *
   * The create path runs `extendObject` for every state once per process — also for
   * states that were already in the database — so "the create path touched it" would
   * report every datapoint as new after each restart. Only what is missing from this
   * snapshot is a real addition (beszel pattern).
   */
  private knownStateIds = new Set<string>();
  /** Datapoints created since the snapshot. */
  private createdStates = 0;
  /** Datapoints removed since the snapshot — excluding the one-shot migration, which reports itself. */
  private removedStates = 0;
  /** Whether the startup balance was already logged. */
  private balanceLogged = false;

  /**
   * Read every existing state id once, before anything creates or deletes.
   *
   * @returns nothing; fills {@link knownStateIds}
   */
  private async snapshotExistingStates(): Promise<void> {
    try {
      const view = await this.getObjectViewAsync("system", "state", {
        startkey: `${this.namespace}.`,
        endkey: `${this.namespace}.\uFFFF`,
      });
      for (const row of view?.rows ?? []) {
        this.knownStateIds.add(row.id.substring(this.namespace.length + 1));
      }
    } catch (e) {
      this.log.debug(`Could not snapshot existing states: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Report what the object tree gained and lost in this startup — one line, both
   * sides, silent when nothing changed. A normal restart must stay quiet.
   */
  private logDatapointBalance(): void {
    if (this.balanceLogged) {
      return;
    }
    this.balanceLogged = true;
    const line = datapointBalanceLine(this.createdStates, this.removedStates);
    if (line) {
      this.log.info(line);
    }
  }

  /**
   * @param options the adapter options
   */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "ai-usage" });
    this.on("ready", this.onReady.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  // ---------------------------------------------------------------- sign-in

  /**
   * Handle admin messages: the three sign-in flows plus their status.
   *
   * @param obj the message
   */
  private async onMessage(obj: ioBroker.Message): Promise<void> {
    try {
      const provider = this.providerFrom(obj.message);
      switch (obj.command) {
        case "signInStart":
          this.respond(obj, provider ? await this.startSignIn(provider) : { error: "unknown provider" });
          return;
        case "signInSubmit":
          this.respond(obj, provider ? await this.submitSignIn(provider, obj.message) : { error: "unknown provider" });
          return;
        case "signInStatus":
          this.respond(obj, provider ? await this.signInState(provider) : { error: "unknown provider" });
          return;
        case "signOut":
          this.respond(obj, provider ? await this.signOut(provider) : { error: "unknown provider" });
          return;
        default:
          // Always answer, or the caller's callback dangles until timeout.
          this.respond(obj, { error: `Unknown command: ${obj.command}` });
      }
    } catch (e) {
      this.log.error(`onMessage failed: ${e instanceof Error ? e.message : String(e)}`);
      this.respond(obj, { error: "internal error — see log" });
    }
  }

  /**
   * Send a message response, when the caller expects one.
   *
   * @param obj the request message
   * @param response the response payload
   */
  private respond(obj: ioBroker.Message, response: unknown): void {
    if (obj.callback) {
      this.sendTo(obj.from, obj.command, response, obj.callback);
    }
  }

  /**
   * The provider kind named in a message, if it is a subscription we know.
   *
   * @param message the message payload ({ provider })
   * @returns the provider kind, or undefined
   */
  private providerFrom(message: unknown): string | undefined {
    const value =
      typeof (message as { provider?: unknown })?.provider === "string"
        ? (message as { provider: string }).provider
        : "";
    return SIGN_IN_FLOWS[value] ? value : undefined;
  }

  /**
   * Begin a sign-in: build the link (Claude/Google) or fetch a device code (ChatGPT).
   *
   * @param provider the subscription kind
   * @returns what the admin panel has to show
   */
  private async startSignIn(provider: string): Promise<SignInState | { error: string }> {
    this.signInErrors.delete(provider);
    this.stopDevicePoller(provider);
    const flow = SIGN_IN_FLOWS[provider];
    const now = Date.now();
    try {
      if (flow === "paste-code") {
        const pkce = generatePkce();
        const url = buildAuthorizeUrl(pkce);
        this.attempts.set(provider, { flow, pkce, url, expiresAt: now + 15 * 60_000 });
        return { status: "awaiting-paste", url, flow };
      }
      if (flow === "paste-url") {
        const pkce = generateGeminiPkce();
        const url = buildGeminiAuthorizeUrl(pkce);
        this.attempts.set(provider, { flow, pkce, url, expiresAt: now + 15 * 60_000 });
        return { status: "awaiting-paste", url, flow };
      }
      const start = await startDeviceCode(postJson, now);
      this.attempts.set(provider, { flow: "device-code", start });
      this.armDevicePoller(provider, start);
      return {
        status: "awaiting-device",
        userCode: start.userCode,
        verificationUrl: CHATGPT_OAUTH.verificationUrl,
        expiresAt: start.expiresAt,
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.signInErrors.set(provider, reason);
      return { status: "failed", reason };
    }
  }

  /**
   * Finish a paste-based sign-in (Claude code, Google address).
   *
   * @param provider the subscription kind
   * @param message the message payload ({ value })
   * @returns the resulting state
   */
  private async submitSignIn(provider: string, message: unknown): Promise<SignInState> {
    const attempt = this.attempts.get(provider);
    const value =
      typeof (message as { value?: unknown })?.value === "string" ? (message as { value: string }).value.trim() : "";
    if (!attempt || attempt.flow === "device-code") {
      return { status: "failed", reason: "start the sign-in first" };
    }
    // The 15-minute window was stored but never enforced — a stale attempt used to
    // fail with the provider's own cryptic answer instead of a clear instruction.
    if (attemptExpired(attempt.expiresAt, Date.now())) {
      this.attempts.delete(provider);
      return { status: "failed", reason: "the sign-in window expired — start the sign-in again" };
    }
    if (!value) {
      return { status: "failed", reason: "nothing pasted" };
    }
    try {
      const now = Date.now();
      const tokens =
        attempt.flow === "paste-code"
          ? await exchangeCode(value, attempt.pkce, postJson, now)
          : await exchangeGeminiCode(extractGeminiCode(value, attempt.pkce.state), attempt.pkce, postForm, now);
      await this.finishSignIn(provider, tokens);
      return { status: "signed-in" };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.signInErrors.set(provider, reason);
      return { status: "failed", reason };
    }
  }

  /**
   * Store fresh tokens, mark the account signed in and poll it right away — waiting
   * up to a full interval after a successful sign-in reads as "it did not work".
   *
   * @param provider the subscription kind
   * @param tokens the token set
   */
  private async finishSignIn(provider: string, tokens: TokenSet): Promise<void> {
    await this.tokenStore(provider).save(tokens);
    this.attempts.delete(provider);
    this.signInErrors.delete(provider);
    this.stopDevicePoller(provider);
    const id = SUBSCRIPTION_IDS[provider];
    if (id) {
      // Started, not awaited: the settings page must confirm the sign-in at once,
      // and a first query that has to wait for a provider can take up to the full
      // request timeout. The values arrive a moment later on their own.
      void this.engine?.pollNow(id).catch(e => {
        this.log.debug(`First query after sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    this.log.info(`${SIGN_IN_LABELS[provider] ?? provider}: signed in`);
  }

  /**
   * Poll the device-code endpoint until the user confirmed, the window closed or
   * the adapter stops. The handle lives in memory only — a restart mid-flow just
   * means the user starts again, which is cheaper than persisting a 15-minute secret.
   *
   * @param provider the subscription kind
   * @param start the device-code handle
   */
  private armDevicePoller(provider: string, start: DeviceCodeStart): void {
    const tick = async (): Promise<void> => {
      try {
        if (attemptExpired(start.expiresAt, Date.now())) {
          this.stopDevicePoller(provider);
          this.attempts.delete(provider);
          this.signInErrors.set(provider, "the code expired — start the sign-in again");
          return;
        }
        const result = await pollDeviceCode(start, postJson);
        if (result.status === "ready") {
          this.stopDevicePoller(provider);
          const tokens = await exchangeDeviceCode(result.code, result.codeVerifier, postForm, Date.now());
          await this.finishSignIn(provider, tokens);
        }
      } catch (e) {
        this.stopDevicePoller(provider);
        this.attempts.delete(provider);
        this.signInErrors.set(provider, e instanceof Error ? e.message : String(e));
      }
    };
    this.devicePollers.set(provider, {
      kind: "interval",
      handle: this.setInterval(() => void tick(), Math.max(start.intervalSec, 1) * 1000),
    });
  }

  /**
   * Stop a running device-code poller.
   *
   * @param provider the subscription kind
   */
  private stopDevicePoller(provider: string): void {
    const handle = this.devicePollers.get(provider);
    if (handle?.kind === "interval") {
      this.clearInterval(handle.handle);
    }
    this.devicePollers.delete(provider);
  }

  /**
   * The current sign-in state of one subscription, for the admin row.
   *
   * @param provider the subscription kind
   * @returns the state
   */
  private async signInState(provider: string): Promise<SignInState> {
    const failure = this.signInErrors.get(provider);
    const attempt = this.attempts.get(provider);
    if (attempt?.flow === "device-code") {
      return {
        status: "awaiting-device",
        userCode: attempt.start.userCode,
        verificationUrl: CHATGPT_OAUTH.verificationUrl,
        expiresAt: attempt.start.expiresAt,
      };
    }
    if (attempt) {
      if (attemptExpired(attempt.expiresAt, Date.now())) {
        this.attempts.delete(provider);
        return { status: "failed", reason: "the sign-in window expired — start the sign-in again" };
      }
      return { status: "awaiting-paste", url: attempt.url, flow: attempt.flow };
    }
    if (failure) {
      return { status: "failed", reason: failure };
    }
    return (await this.tokenStore(provider).load()) ? { status: "signed-in" } : { status: "signed-out" };
  }

  /**
   * Forget the tokens of one subscription.
   *
   * @param provider the subscription kind
   * @returns the resulting state
   */
  private async signOut(provider: string): Promise<SignInState> {
    await this.tokenStore(provider).clear();
    this.attempts.delete(provider);
    this.signInErrors.delete(provider);
    this.stopDevicePoller(provider);
    return { status: "signed-out" };
  }

  // ------------------------------------------------------------ token files

  /**
   * The token store of one subscription — created ONCE per provider.
   *
   * The identity matters: the store holds the in-memory copy of the tokens, so
   * signing out really takes effect. When each provider module kept its own copy,
   * a sign-out deleted the file while the adapter kept polling with what it still
   * had — and the next token refresh wrote the deleted file back.
   *
   * @param provider the subscription kind
   * @returns the store
   */
  private tokenStore(provider: string): TokenStore {
    let store = this.tokenStores.get(provider);
    if (!store) {
      store = this.makeTokenStore(provider);
      this.tokenStores.set(provider, store);
    }
    return store;
  }

  /**
   * Build the store for one subscription: an encrypted file in the instance data
   * directory, named after the PROVIDER. Keying by provider (not by account name)
   * keeps a sign-in alive when an account is renamed — the previous scheme lost it.
   *
   * @param provider the subscription kind
   * @returns the store
   */
  private makeTokenStore(provider: string): TokenStore {
    const dir = utils.getAbsoluteInstanceDataDir(this);
    const file = join(dir, `tokens-${provider}.json`);
    let cached: TokenSet | null = null;
    let read = false;
    return {
      load: async (): Promise<TokenSet | null> => {
        if (!read) {
          cached = await this.readTokenFile(file, provider);
          read = true;
        }
        return cached;
      },
      save: async (tokens: TokenSet): Promise<void> => {
        await mkdir(dir, { recursive: true });
        await writeFile(file, this.encrypt(JSON.stringify(tokens)), "utf8");
        cached = tokens;
        read = true;
      },
      clear: async (): Promise<void> => {
        cached = null;
        read = true;
        await unlink(file).catch(() => {
          /* already gone */
        });
      },
    };
  }

  /**
   * Read one token file.
   *
   * A missing file means "never signed in" and is silent. A file that is there but
   * cannot be read — damaged, or encrypted with a different instance secret — is
   * NOT the same thing: without a word in the log, signing in would look like it
   * simply does nothing.
   *
   * @param file the file path
   * @param provider the subscription kind (for the log line)
   * @returns the tokens, or null
   */
  private async readTokenFile(file: string, provider: string): Promise<TokenSet | null> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.log.warn(`${SIGN_IN_LABELS[provider] ?? provider}: cannot open the stored sign-in (${String(e)})`);
      }
      return null; // never signed in — the provider reports auth-required
    }
    try {
      const parsed = JSON.parse(this.decrypt(raw)) as Partial<TokenSet>;
      if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") {
        throw new Error("the file carries no tokens");
      }
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: Number(parsed.expiresAt) || 0,
        accountRef: typeof parsed.accountRef === "string" ? parsed.accountRef : undefined,
      };
    } catch (e) {
      this.log.warn(
        `${SIGN_IN_LABELS[provider] ?? provider}: the stored sign-in cannot be read (${
          e instanceof Error ? e.message : String(e)
        }) — sign in again in the instance settings`,
      );
      return null;
    }
  }

  /**
   * Carry a sign-in from the pre-0.3.0 layout over: tokens used to be stored per
   * ACCOUNT NAME (`claude-tokens-<name>.json`). Without this the rename to fixed
   * account ids would silently sign the user out.
   */
  private async migrateTokenFiles(): Promise<void> {
    const dir = utils.getAbsoluteInstanceDataDir(this);
    const target = join(dir, "tokens-claude-sub.json");
    try {
      await readFile(target, "utf8");
      return; // already migrated
    } catch {
      // not there yet — look for an old file
    }
    for (const legacy of ["claude-tokens-Claude.json", "claude-tokens-claude.json"]) {
      try {
        await rename(join(dir, legacy), target);
        this.log.info("Carried the existing Claude sign-in over to the new layout");
        return;
      } catch {
        // try the next candidate
      }
    }
  }

  // ------------------------------------------------------------- life cycle

  /** Validate the configuration, clean up stale objects and start the engine. */
  private async onReady(): Promise<void> {
    try {
      const accounts = parseAccounts(this.config.accounts);
      const interval = clampPollInterval(this.config.pollInterval);
      await this.migrateTokenFiles();
      // Baseline first: the cleanup deletes and the engine creates, both are counted
      // against this snapshot.
      await this.snapshotExistingStates();
      await this.cleanupStaleObjects();
      const retired = await this.removeRetiredStates(accounts);
      if (retired > 0) {
        this.log.info(`Object tree updated: removed ${retired} obsolete status datapoint(s)`);
      }
      if (accounts.length === 0) {
        this.log.info("No AI accounts configured — add accounts in the instance settings");
        await this.setState("info.connection", { val: false, ack: true });
        return;
      }
      const providers = new Map<string, UsageProvider>();
      for (const account of accounts) {
        const provider = await this.makeProvider(account);
        if (provider) {
          providers.set(account.id, provider);
        }
      }
      this.engine = new PollEngine(accounts, providers, interval, {
        upsertObject: async def => {
          await this.extendObject(def.id, { type: def.type, common: def.common as ioBroker.ObjectCommon, native: {} });
          if (def.type === "state" && !this.knownStateIds.has(def.id)) {
            this.knownStateIds.add(def.id);
            this.createdStates++;
          }
        },
        setState: (id, value) => {
          void this.setState(id, { val: value, ack: true }).catch(() => {
            /* states DB going down — never crash the poll loop */
          });
        },
        setStateChanged: async (id, value) => {
          // Awaited only by the shutdown path; the poll loop drops the promise.
          await this.setStateChangedAsync(id, { val: value, ack: true }).catch(() => {
            /* states DB going down — never crash the poll loop */
          });
        },
        deleteObject: async id => {
          try {
            await this.delObjectAsync(id, { recursive: true });
            if (this.knownStateIds.delete(id)) {
              this.removedStates++;
            }
          } catch (e) {
            this.log.debug(`Could not remove ${id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
        listStateIds: async prefix => {
          const start = `${this.namespace}.${prefix}.`;
          const view = await this.getObjectViewAsync("system", "state", {
            startkey: start,
            endkey: `${start}￿`,
          });
          return (view?.rows ?? []).map(row => row.id.substring(this.namespace.length + 1));
        },
        schedule: (cb, ms): TimerHandle => ({ kind: "interval", handle: this.setInterval(cb, ms) }),
        scheduleOnce: (cb, ms): TimerHandle => ({ kind: "timeout", handle: this.setTimeout(cb, ms) }),
        cancel: handle => {
          const timer = handle as TimerHandle;
          if (timer.kind === "interval") {
            this.clearInterval(timer.handle);
          } else {
            this.clearTimeout(timer.handle);
          }
        },
        now: () => Date.now(),
        log: {
          debug: m => this.log.debug(m),
          info: m => this.log.info(m),
          warn: m => this.log.warn(m),
          error: m => this.log.error(m),
        },
        afterFirstRound: () => this.logDatapointBalance(),
        notify: this.config.notifications
          ? (_account, message) =>
              void this.registerNotification("ai-usage", "userActionRequired", message).catch(e =>
                this.log.debug(`Could not raise notification: ${e instanceof Error ? e.message : String(e)}`),
              )
          : undefined,
      });
      await this.engine.start();
      this.log.info(`Monitoring ${providers.size} of ${accounts.length} AI account(s), polling every ${interval} s`);
    } catch (e) {
      this.log.error(`Startup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Build the provider for one account.
   *
   * @param account the validated account config
   * @returns the provider, or undefined to skip the account
   */
  private async makeProvider(account: AccountConfig): Promise<UsageProvider | undefined> {
    switch (account.provider) {
      case "claude-sub":
        return claudeSubProvider(this.tokenStore(account.provider), postJson);
      case "chatgpt-sub":
        return chatgptSubProvider(this.tokenStore(account.provider), postJson);
      case "gemini-sub":
        return geminiSubProvider(this.tokenStore(account.provider), postJson, postForm);
      case "openrouter": {
        const key = await this.resolveKey(account);
        return key ? openRouterProvider(key) : undefined;
      }
      case "deepseek": {
        const key = await this.resolveKey(account);
        return key ? deepSeekProvider(key) : undefined;
      }
      case "openai": {
        const key = await this.resolveKey(account);
        return key ? openAiProvider(key) : undefined;
      }
      case "anthropic-api": {
        const key = await this.resolveKey(account);
        return key ? anthropicApiProvider(key) : undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * Read and decrypt a key-form credential from the central credential storage.
   *
   * @param account the account whose credential to resolve
   * @returns the key, or undefined (with a log line) when it cannot be read
   */
  private async resolveKey(account: AccountConfig): Promise<string | undefined> {
    if (!account.credentialId) {
      this.log.warn(`${account.name}: no credential selected — pick one in the instance settings`);
      return undefined;
    }
    try {
      const credential = await Credentials.getCredentials(this, account.credentialId);
      const values = credential.values as { key?: unknown };
      const key = typeof values.key === "string" && values.key ? values.key : undefined;
      if (!key) {
        this.log.warn(`${account.name}: credential ${account.credentialId} carries no API key`);
      }
      return key;
    } catch (e) {
      this.log.warn(
        `${account.name}: cannot read credential ${account.credentialId} (${e instanceof Error ? e.message : String(e)})`,
      );
      return undefined;
    }
  }

  /**
   * Status states retired in 0.5.0 — `provider` (visible in the node name anyway),
   * `reachable`/`serviceOnline`/`state` (three spellings of one fact) and `signedIn`
   * (the settings page asks the adapter directly).
   *
   * ioBroker never garbage-collects an object whose id the adapter stopped writing:
   * it would sit there frozen on its last value and keep lying. So the old ids are
   * deleted from a fixed list — no state reading, no heuristics.
   */
  private static readonly RETIRED_INFO_STATES = [
    "info.provider",
    "info.reachable",
    "info.serviceOnline",
    "info.state",
    "info.signedIn",
  ];

  /**
   * Remove the retired status states of every configured account.
   *
   * Which of them still exist is answered by the startup snapshot that was read a
   * moment earlier — asking the database for every id on every start would keep
   * costing 35 lookups forever for a migration that is done after the first one.
   *
   * @param accounts the configured accounts
   * @returns how many objects were actually deleted
   */
  private async removeRetiredStates(accounts: readonly AccountConfig[]): Promise<number> {
    let removed = 0;
    for (const account of accounts) {
      for (const suffix of AiUsageAdapter.RETIRED_INFO_STATES) {
        const id = `${account.id}.${suffix}`;
        if (!this.knownStateIds.has(id)) {
          continue;
        }
        try {
          await this.delObjectAsync(id);
          removed++;
          // Deliberately NOT counted in the startup balance: this one-shot migration
          // reports its own sum, and the same deletion must not appear in two lines
          // that mean different things.
          this.knownStateIds.delete(id);
        } catch (e) {
          this.log.debug(`Could not remove ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return removed;
  }

  /**
   * Delete object trees that no longer belong to a configured account, plus the
   * `auth` branch of the pre-0.3.0 layout. An EMPTY table deletes nothing — the
   * guard against wiping everything through an accidental clear.
   */
  private async cleanupStaleObjects(): Promise<void> {
    const keepIds = parseAccounts(this.config.accounts).map(account => account.id);
    if (keepIds.length === 0) {
      return;
    }
    const keep = new Set([...keepIds, "info", "total"]);
    try {
      const objects = await this.getAdapterObjectsAsync();
      const roots = new Set<string>();
      for (const id of Object.keys(objects)) {
        const root = id.substring(this.namespace.length + 1).split(".")[0];
        if (root && !keep.has(root)) {
          roots.add(root);
        }
      }
      for (const root of roots) {
        this.log.info(
          root === "auth"
            ? "Removing the old sign-in branch — the sign-in state now lives inside each account"
            : `Removing objects of no longer configured account "${root}"`,
        );
        // Count the datapoints BEFORE they are gone — afterwards there is nothing to count.
        for (const id of [...this.knownStateIds]) {
          if (id === root || id.startsWith(`${root}.`)) {
            this.knownStateIds.delete(id);
            this.removedStates++;
          }
        }
        await this.delObjectAsync(root, { recursive: true });
      }
    } catch (e) {
      this.log.warn(`Cleanup of stale objects failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Tear down: cancel everything, then say that nothing is delivering any more.
   *
   * The final writes are AWAITED before `callback()` — measured on the live server
   * (2026-08-27), a fire-and-forget write followed by an immediate callback never
   * reached the database, so a switched-off instance kept showing every account as
   * online. The whole thing takes about 100 ms.
   *
   * Deliberately WITHOUT a time limit of its own: the adapter's timer API refuses to
   * arm once shutdown has begun, and the host already applies the only deadline that
   * matters — it ends the process a second after asking. A states database that
   * hangs would swallow the writes either way, so a second guard adds code, not
   * safety.
   *
   * None of this runs while `common.supportedMessages.stopInstance` sits in the
   * manifest: with it the host kills the process outright instead of asking, and
   * every state written here is dead code. A test pins that the entry stays out.
   *
   * @param callback invoked when cleanup is done
   */
  private onUnload(callback: () => void): void {
    try {
      for (const provider of [...this.devicePollers.keys()]) {
        this.stopDevicePoller(provider);
      }
      const engine = this.engine;
      this.engine?.stop();
      this.engine = null;
      void (engine?.markAllOffline() ?? this.setState("info.connection", { val: false, ack: true }))
        .then(() => this.log.debug("Shutdown: final states written"))
        .catch(e => this.log.debug(`Shutdown: final states rejected — ${e instanceof Error ? e.message : String(e)}`))
        .finally(callback);
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new AiUsageAdapter(options);
} else {
  (() => new AiUsageAdapter())();
}

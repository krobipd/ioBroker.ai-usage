import * as utils from "@iobroker/adapter-core";
import { Credentials } from "@iobroker/adapter-core";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getJson, postForm, postJson } from "./lib/http";
import { loadCatalogue, tName } from "./lib/i18n";
import { PollEngine } from "./lib/poll-engine";
import {
  clampPollInterval,
  datapointBalanceLine,
  parseAccounts,
  SUBSCRIPTION_IDS,
  type AccountConfig,
} from "./lib/pure-helpers";
import type { TokenSet, TokenStore, UsageProvider } from "./lib/provider";
import { PROVIDER_LABELS, SIGN_IN_FLOWS, type SignInState } from "./lib/sign-in";
import { SignInManager } from "./lib/sign-in-manager";
import { claudeSubProvider } from "./lib/providers/claude-sub";
import { chatgptSubProvider } from "./lib/providers/chatgpt-sub";
import { geminiSubProvider } from "./lib/providers/gemini-sub";
import { anthropicApiProvider } from "./lib/providers/anthropic-api";
import { deepSeekProvider } from "./lib/providers/deepseek";
import { openAiProvider } from "./lib/providers/openai";
import { openRouterProvider } from "./lib/providers/openrouter";

/** Reverse of {@link SUBSCRIPTION_IDS}: which subscription owns an account id. */
const PROVIDER_BY_ACCOUNT_ID: Record<string, string> = Object.fromEntries(
  Object.entries(SUBSCRIPTION_IDS).map(([provider, id]) => [id, provider]),
);

/**
 * High sort-end marker for object-view key ranges (`startkey: prefix, endkey:
 * prefix + SORT_KEY_END` covers every id below the prefix). One constant instead
 * of the two spellings that had crept in.
 */
const SORT_KEY_END = "￿";

/** A cancellable handle: interval or timeout — the engine treats them uniformly. */
type TimerHandle =
  | { kind: "interval"; handle: ioBroker.Interval | undefined }
  | { kind: "timeout"; handle: ioBroker.Timeout | undefined };

/**
 * AI Usage adapter — reads usage windows, credits and costs of AI accounts into
 * read-only states. Three subscriptions sign in with the user's own account
 * (Claude, ChatGPT, Google), the other accounts use a key from the admin's central
 * credential storage. Orchestration lives in the unit-tested {@link PollEngine},
 * the sign-in flows in {@link SignInManager}; this class wires ioBroker IO and the
 * token files to them.
 */
export class AiUsageAdapter extends utils.Adapter {
  private engine: PollEngine | null = null;
  /** One token store per subscription — see {@link tokenStore} for why it is shared. */
  private readonly tokenStores = new Map<string, TokenStore>();
  /** The three sign-in flows, their running attempts and what the settings page shows. */
  private readonly signIn: SignInManager;

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
  /** Datapoints removed since the snapshot. */
  private removedStates = 0;
  /** Whether the startup balance was already logged. */
  private balanceLogged = false;

  /**
   * @param options the adapter options
   */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "ai-usage" });
    this.signIn = new SignInManager({
      store: provider => this.tokenStore(provider),
      postJson,
      postForm,
      now: () => Date.now(),
      schedule: (cb, ms) => this.setInterval(cb, ms),
      cancel: handle => this.clearInterval(handle as ioBroker.Interval),
      log: { info: m => this.log.info(m), debug: m => this.log.debug(m) },
      onSignedIn: provider => {
        const id = SUBSCRIPTION_IDS[provider];
        if (!id) {
          return;
        }
        // Started, not awaited: the settings page must confirm the sign-in at once,
        // and a first query that has to wait for a provider can take up to the full
        // request timeout. The values arrive a moment later on their own.
        void this.engine?.pollNow(id).catch(e => {
          this.log.debug(`First query after sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      },
    });
    this.on("ready", this.onReady.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  // ---------------------------------------------------------------- messages

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
        case "signInSubmit":
        case "signInStatus":
        case "signOut":
          if (!provider) {
            this.respond(obj, { error: "unknown provider" });
            return;
          }
          this.respond(obj, await this.runSignIn(obj.command, provider, this.valueFrom(obj.message)));
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
   * Run one sign-in command.
   *
   * @param command the message command
   * @param provider the subscription kind
   * @param value the pasted value, for signInSubmit
   * @returns the resulting state
   */
  private async runSignIn(command: string, provider: string, value: string): Promise<SignInState> {
    switch (command) {
      case "signInStart":
        return this.signIn.start(provider);
      case "signInSubmit":
        return this.signIn.submit(provider, value);
      case "signOut":
        return this.signIn.signOut(provider);
      default:
        return this.signIn.state(provider);
    }
  }

  /**
   * Send a message response, when the caller expects one.
   *
   * @param obj the request message
   * @param response the response payload
   */
  private respond(obj: ioBroker.Message, response: SignInState | { error: string }): void {
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
   * The pasted value carried by a message (API boundary — anything can arrive).
   *
   * @param message the message payload ({ value })
   * @returns the string, or ""
   */
  private valueFrom(message: unknown): string {
    return typeof (message as { value?: unknown })?.value === "string" ? (message as { value: string }).value : "";
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
   * keeps a sign-in alive when an account is renamed.
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
        // Owner-only file mode on top of the encryption — same hardening as the
        // govee credentials file; the content is ciphertext either way.
        await writeFile(file, this.encrypt(JSON.stringify(tokens)), { encoding: "utf8", mode: 0o600 });
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
        this.log.warn(`${PROVIDER_LABELS[provider] ?? provider}: cannot open the stored sign-in (${String(e)})`);
      }
      return null; // never signed in — the provider reports that no sign-in exists
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
        `${PROVIDER_LABELS[provider] ?? provider}: the stored sign-in cannot be read (${
          e instanceof Error ? e.message : String(e)
        }) — sign in again in the instance settings`,
      );
      return null;
    }
  }

  // ------------------------------------------------------------- life cycle

  /**
   * Remove a leftover `supportedMessages` key from THIS instance's object.
   *
   * The entry lives in two places: in the adapter's manifest, and as a copy in the
   * instance object in the database. An update merges the manifest into that copy —
   * it never removes a field. So on every installation that ran a version carrying
   * the entry, the host keeps killing the process outright and `onUnload` still never
   * runs: the update alone changes nothing (found by a second pair of eyes on the
   * live server 2026-08-27, after my own test had been contaminated by a value I had
   * set by hand).
   *
   * 0.9.2 wrote `{ stopInstance: false }` here, which made it WORSE: the key is a
   * positive list, so an object without a value other than false shuts the message
   * box — the host no longer looks at `common.messagebox`, never subscribes, and no
   * `sendTo` reaches the adapter, without a single line in the log. Every sign-in
   * from the settings page went nowhere (measured on the live server 2026-09-04:
   * `supportedMessages: {"stopInstance": false}`). The key has to be DELETED, and
   * the trigger has to be its mere existence — the old guard read `stopInstance`
   * and therefore never saw the state it had written itself.
   *
   * Writing the instance object makes the host restart this instance once. That is
   * the price, it happens on the first start after the update and never again —
   * afterwards the condition below is false. public-holidays corrects its own run
   * mode the same way.
   *
   * @returns true when the correction was written and the restart is coming — the
   *   caller has to stop right there. Carrying on would arm the poll timers of a
   *   process the host is already shutting down, which the adapter's timer API
   *   refuses with a warning in the user's log (measured on the live server).
   */
  private async clearStopInstanceFlag(): Promise<boolean> {
    const id = `system.adapter.${this.namespace}`;
    try {
      const obj = await this.getForeignObjectAsync(id);
      const supported = obj?.common?.supportedMessages as Record<string, unknown> | undefined | null;
      // The trigger is the KEY EXISTING AT ALL, not the value behind `stopInstance`.
      // A guard reading `stopInstance` never sees the state it wrote itself, so a
      // half-corrected installation stayed half-corrected forever.
      if (supported === undefined || supported === null) {
        return false;
      }
      this.log.info("Correcting a leftover setting from an earlier version — this instance restarts once");
      // DELETE the key — `null` is what extendObject copies over an existing value.
      // Writing `{ stopInstance: false }` leaves an OBJECT behind, and
      // `supportedMessages` is a positive list: an object without a value other than
      // false makes the host stop looking at `common.messagebox` and never subscribe —
      // no `sendTo` reaches the adapter and nothing is logged. That is what killed
      // every sign-in message from the settings page.
      //
      // This adapter must never declare the key (decision 19a, pinned by a test), so
      // deleting all of it is right here. An adapter that legitimately needs it
      // (`deviceManager`) would have to strip only the one entry — that case is the
      // fleet's to decide, not this adapter's.
      await this.extendForeignObjectAsync(id, { common: { supportedMessages: null } });
      return true;
    } catch (e) {
      this.log.debug(`Could not check the instance object: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /**
   * The directory holding `i18n/<lang>.json` — `admin/`, one level above `build/`.
   *
   * @returns the absolute path
   */
  private i18nRoot(): string {
    return join(__dirname, "..", "admin");
  }

  /**
   * Load the object-name catalogue before anything creates an object.
   *
   * A failure here must not stop the adapter — the objects would carry their keys as
   * names, which is ugly but traceable, and every value would still be correct. It
   * is loud in the log for exactly that reason.
   */
  private loadTranslations(): void {
    try {
      const count = loadCatalogue(this.i18nRoot());
      this.log.debug(`Object name catalogue loaded (${count} entries)`);
    } catch (e) {
      this.log.warn(
        `Object names fall back to their keys — the translations could not be read (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
    }
  }

  /**
   * Objects declared in the manifest, refreshed on every start.
   *
   * js-controller applies `instanceObjects` itself, but with `preserve` on
   * `common.name`: a RENAMED object reaches new installations only, while every
   * existing tree keeps the old text and the manifest looks correct all the while.
   * The explicit refresh is what carries a changed name or description into an
   * installation that already exists (fleet rule).
   */
  private async refreshManifestObjects(): Promise<void> {
    try {
      // Spelled out one by one, with literal ids: a loop over a table would hide
      // which objects are covered, from a reader and from the consistency gate alike.
      await this.extendObject("info", {
        type: "channel",
        common: { name: tName("nameInfoChannel") },
        native: {},
      });
      await this.extendObject("info.connection", {
        type: "state",
        // The only one of the three with something to explain — the two containers
        // stay without a description rather than getting an invented sentence.
        common: { name: tName("nameConnection"), desc: tName("descConnection") },
        native: {},
      });
      await this.extendObject("total", {
        type: "folder",
        common: { name: tName("nameTotalFolder") },
        native: {},
      });
    } catch (e) {
      // A failure here costs a name, never the startup.
      this.log.debug(`Could not refresh the manifest objects: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Validate the configuration, clean up stale objects and start the engine. */
  private async onReady(): Promise<void> {
    try {
      // First: without this the whole shutdown path stays dead on an updated install.
      // A correction means the host is restarting us — no point setting anything up.
      if (await this.clearStopInstanceFlag()) {
        return;
      }
      // Before anything creates an object — every name below comes from here.
      this.loadTranslations();
      await this.refreshManifestObjects();
      // Parsed ONCE and handed on: the cleanup used to parse the same table a second
      // time, so a change in the parser could have been applied to one and not the
      // other.
      const { accounts, discarded } = parseAccounts(this.config.accounts);
      for (const row of discarded) {
        // Named, not swallowed: the start line below counts what survived, so a row
        // that vanished here left the user with no way to tell it ever existed.
        this.log.warn(`Account row "${row.label}" is not being monitored — ${row.reason}`);
      }
      const interval = clampPollInterval(this.config.pollInterval);
      // Baseline first: the cleanup deletes and the engine creates, both are counted
      // against this snapshot.
      await this.snapshotExistingStates();
      await this.cleanupStaleObjects(accounts);
      await this.removeMovedStates(accounts);
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
          if (def.type === "state") {
            this.countUpsert(def.id);
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
        readState: async id => {
          const state = await this.getStateAsync(id).catch(() => null);
          return state?.val ?? null;
        },
        listStateIds: async prefix => {
          const start = `${this.namespace}.${prefix}.`;
          const view = await this.getObjectViewAsync("system", "state", {
            startkey: start,
            endkey: `${start}${SORT_KEY_END}`,
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
        authState: (accountId, rejected) => {
          const provider = PROVIDER_BY_ACCOUNT_ID[accountId];
          if (provider) {
            this.signIn.setRejected(provider, rejected);
          }
        },
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
   * Read every existing state id once, before anything creates or deletes.
   *
   * @returns nothing; fills {@link knownStateIds}
   */
  private async snapshotExistingStates(): Promise<void> {
    try {
      const view = await this.getObjectViewAsync("system", "state", {
        startkey: `${this.namespace}.`,
        endkey: `${this.namespace}.${SORT_KEY_END}`,
      });
      for (const row of view?.rows ?? []) {
        this.knownStateIds.add(row.id.substring(this.namespace.length + 1));
      }
    } catch (e) {
      this.log.debug(`Could not snapshot existing states: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Count one state the create path just touched — but only if it is genuinely new.
   *
   * The create path runs `extendObject` for EVERY state once per process, including
   * the ones that were already in the database. "The create path touched it" would
   * therefore report the whole tree as new after every restart, and the balance line
   * would be noise within a day. Only what the startup snapshot did not hold counts.
   *
   * @param id the state id, relative to the instance
   */
  private countUpsert(id: string): void {
    if (!this.knownStateIds.has(id)) {
      this.knownStateIds.add(id);
      this.createdStates++;
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
   * Build the provider for one account.
   *
   * @param account the validated account config
   * @returns the provider, or undefined to leave the account unpolled
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
        return key ? openAiProvider(key, getJson, Date.now, m => this.log.warn(`${account.name}: ${m}`)) : undefined;
      }
      case "anthropic-api": {
        const key = await this.resolveKey(account);
        return key
          ? anthropicApiProvider(key, getJson, Date.now, m => this.log.warn(`${account.name}: ${m}`))
          : undefined;
      }
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
   * States that moved to a new path in 0.12.0.
   *
   * `available` (DeepSeek's "balance still covers calls") sat at the account root
   * next to `warning` and `limitReached`, where it read as a third account-wide
   * alarm; it belongs to the balance and now lives under `credits`. ioBroker never
   * removes an object whose id an adapter stopped writing, so the old one would sit
   * there frozen on its last value — the adapter cleans up after itself.
   */
  private static readonly MOVED_STATES = ["available"];

  /**
   * Delete the old ids of states that moved, for every configured account.
   *
   * Which of them still exist is answered by the startup snapshot read a moment
   * earlier — asking the database for every id on every start would keep costing
   * lookups forever for a migration that is done after the first one.
   *
   * @param accounts the configured accounts
   */
  private async removeMovedStates(accounts: readonly AccountConfig[]): Promise<void> {
    for (const account of accounts) {
      for (const suffix of AiUsageAdapter.MOVED_STATES) {
        const id = `${account.id}.${suffix}`;
        if (!this.knownStateIds.has(id)) {
          continue;
        }
        try {
          await this.delObjectAsync(id);
          this.knownStateIds.delete(id);
          this.removedStates++;
        } catch (e) {
          this.log.debug(`Could not remove ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  /**
   * Delete object trees that no longer belong to a configured account. An EMPTY
   * table deletes nothing — the guard against wiping everything through an
   * accidental clear.
   *
   * @param accounts the configured accounts
   */
  private async cleanupStaleObjects(accounts: readonly AccountConfig[]): Promise<void> {
    if (accounts.length === 0) {
      return;
    }
    const keep = new Set([...accounts.map(account => account.id), "info", "total"]);
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
        this.log.info(`Removing objects of no longer configured account "${root}"`);
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
      this.signIn.stopAll();
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

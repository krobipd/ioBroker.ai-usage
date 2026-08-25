import * as utils from "@iobroker/adapter-core";
import { Credentials } from "@iobroker/adapter-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { postJson } from "./lib/http";
import { PollEngine } from "./lib/poll-engine";
import { clampPollInterval, parseAccounts, sanitizeId, validAccountIds, type AccountConfig } from "./lib/pure-helpers";
import type { UsageProvider } from "./lib/provider";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  type PkcePair,
  type TokenSet,
} from "./lib/providers/claude-auth";
import { anthropicApiProvider } from "./lib/providers/anthropic-api";
import { claudeSubProvider, type TokenStore } from "./lib/providers/claude-sub";
import { deepSeekProvider } from "./lib/providers/deepseek";
import { openAiProvider } from "./lib/providers/openai";
import { openRouterProvider } from "./lib/providers/openrouter";

/** A cancellable handle: interval or timeout — the engine treats them uniformly. */
type TimerHandle =
  | { kind: "interval"; handle: ioBroker.Interval | undefined }
  | { kind: "timeout"; handle: ioBroker.Timeout | undefined };

/**
 * AI Usage adapter — polls the usage/limit/cost sources of configured AI accounts
 * (Claude subscription, OpenRouter, DeepSeek, OpenAI API, Anthropic API) and
 * mirrors them into read-only states. Orchestration lives in the
 * fully unit-tested {@link PollEngine}; this class only wires ioBroker IO to it.
 */
export class AiUsageAdapter extends utils.Adapter {
  private engine: PollEngine | null = null;
  /** Pending Claude sign-in attempts, keyed by account id (PKCE lives only in memory). */
  private readonly pendingClaudeAuth = new Map<string, PkcePair>();

  /**
   * @param options the adapter options
   */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "ai-usage" });
    this.on("ready", this.onReady.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /**
   * Handle admin messages — the guided Claude subscription sign-in.
   *
   * @param obj the message
   */
  private async onMessage(obj: ioBroker.Message): Promise<void> {
    try {
      switch (obj.command) {
        case "claudeAuthStart": {
          // Regenerate the sign-in link for one account (invalidates the previous one).
          const accountId = this.claudeAccountIdFrom(obj.message);
          if (!accountId) {
            this.respond(obj, { error: "Save the settings with a Claude subscription account first" });
            return;
          }
          const url = await this.publishClaudeSignInUrl(accountId);
          this.respond(obj, { url });
          return;
        }
        case "claudeAuthCode": {
          const accountId = this.claudeAccountIdFrom(obj.message);
          const code =
            typeof (obj.message as { code?: unknown })?.code === "string" ? (obj.message as { code: string }).code : "";
          const pkce = accountId ? this.pendingClaudeAuth.get(accountId) : undefined;
          if (!accountId || !pkce) {
            this.respond(obj, { error: "Save the settings with a Claude subscription account first" });
            return;
          }
          if (!code.trim()) {
            this.respond(obj, { error: "Paste the code from the Anthropic page first" });
            return;
          }
          try {
            const tokens = await exchangeCode(code, pkce, postJson, Date.now());
            await this.claudeTokenStore(accountId).save(tokens);
            this.pendingClaudeAuth.delete(accountId);
            await this.setClaudeAuthStates(accountId, "", true);
            this.respond(obj, { result: "ok" });
          } catch (e) {
            this.respond(obj, { error: `Sign-in failed: ${e instanceof Error ? e.message : String(e)}` });
          }
          return;
        }
        default:
          // Always answer, or the caller's callback would dangle until timeout.
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
   * Resolve the account id for a Claude sign-in message: the given name must match
   * a claude-sub row of the accounts table.
   *
   * @param message the message payload ({ account })
   * @returns the id-safe account id, or undefined
   */
  private claudeAccountIdFrom(message: unknown): string | undefined {
    const name =
      typeof (message as { account?: unknown })?.account === "string" ? (message as { account: string }).account : "";
    const id = sanitizeId(name);
    if (!id) {
      return undefined;
    }
    const accounts = parseAccounts(this.config.accounts);
    return accounts.some(account => account.id === id && account.provider === "claude-sub") ? id : undefined;
  }

  /**
   * Create the `auth.<id>` states of one Claude account and publish a FRESH
   * sign-in link (the adapter owns the secret; the link stays valid until it is
   * regenerated or redeemed — the admin card only displays it).
   *
   * @param accountId the id-safe account id
   * @returns the sign-in URL
   */
  private async publishClaudeSignInUrl(accountId: string): Promise<string> {
    const pkce = generatePkce();
    this.pendingClaudeAuth.set(accountId, pkce);
    const url = buildAuthorizeUrl(pkce);
    await this.setClaudeAuthStates(accountId, url, false);
    return url;
  }

  /**
   * Create (once) and write the two `auth.<id>` states of one Claude account.
   *
   * @param accountId the id-safe account id
   * @param url the current sign-in URL ("" when signed in)
   * @param signedIn whether a usable sign-in exists
   */
  private async setClaudeAuthStates(accountId: string, url: string, signedIn: boolean): Promise<void> {
    await this.extendObject("auth", {
      type: "folder",
      common: { name: { en: "Sign-in", de: "Anmeldung" } },
      native: {},
    });
    await this.extendObject(`auth.${accountId}`, {
      type: "channel",
      common: { name: accountId },
      native: {},
    });
    await this.extendObject(`auth.${accountId}.signInUrl`, {
      type: "state",
      common: {
        name: { en: "Sign-in link", de: "Anmelde-Link" },
        type: "string",
        role: "url",
        read: true,
        write: false,
        def: "",
      },
      native: {},
    });
    await this.extendObject(`auth.${accountId}.signedIn`, {
      type: "state",
      common: {
        name: { en: "Signed in", de: "Angemeldet" },
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    await this.setState(`auth.${accountId}.signInUrl`, { val: url, ack: true });
    await this.setState(`auth.${accountId}.signedIn`, { val: signedIn, ack: true });
  }

  /**
   * Prepare the guided sign-in of every Claude subscription account: publish the
   * live status, and for accounts without a usable sign-in a stable sign-in link.
   *
   * @param accounts the validated account configs
   */
  private async prepareClaudeAuth(accounts: AccountConfig[]): Promise<void> {
    const claudeAccounts = accounts.filter(a => a.provider === "claude-sub");
    // Remove sign-in channels of accounts that are gone (the account cleanup only
    // handles top-level account trees, not the shared auth folder).
    try {
      const wanted = new Set(claudeAccounts.map(a => a.id));
      const objects = await this.getAdapterObjectsAsync();
      const stale = new Set<string>();
      for (const id of Object.keys(objects)) {
        const relative = id.substring(this.namespace.length + 1);
        const [root, child] = relative.split(".");
        if (root === "auth" && child && !wanted.has(child)) {
          stale.add(child);
        }
      }
      for (const child of stale) {
        await this.delObjectAsync(`auth.${child}`, { recursive: true });
      }
    } catch {
      // cleanup only — never block startup
    }
    for (const account of claudeAccounts) {
      try {
        const tokens = await this.claudeTokenStore(account.id).load();
        if (tokens) {
          await this.setClaudeAuthStates(account.id, "", true);
        } else {
          await this.publishClaudeSignInUrl(account.id);
        }
      } catch (e) {
        this.log.warn(`${account.name}: cannot prepare sign-in (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }

  /**
   * The persistent token storage for one Claude account: an encrypted JSON file in
   * the instance data directory (a `native` write would restart the instance).
   *
   * @param accountId the id-safe account id
   * @returns the store
   */
  private claudeTokenStore(accountId: string): TokenStore {
    const dir = utils.getAbsoluteInstanceDataDir(this);
    const file = join(dir, `claude-tokens-${accountId}.json`);
    return {
      load: async (): Promise<TokenSet | null> => {
        try {
          const encrypted = await readFile(file, "utf8");
          const parsed = JSON.parse(this.decrypt(encrypted)) as Partial<TokenSet>;
          if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") {
            return null;
          }
          return {
            accessToken: parsed.accessToken,
            refreshToken: parsed.refreshToken,
            expiresAt: Number(parsed.expiresAt) || 0,
          };
        } catch {
          return null; // never signed in (or unreadable) — the provider reports auth-required
        }
      },
      save: async (tokens: TokenSet): Promise<void> => {
        await mkdir(dir, { recursive: true });
        await writeFile(file, this.encrypt(JSON.stringify(tokens)), "utf8");
      },
    };
  }

  /** Validate the configuration, clean up stale account trees and start the engine. */
  private async onReady(): Promise<void> {
    try {
      const accounts = parseAccounts(this.config.accounts);
      const interval = clampPollInterval(this.config.pollInterval);
      await this.cleanupStaleAccounts();
      await this.prepareClaudeAuth(accounts);
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
        },
        setState: (id, value) => {
          void this.setState(id, { val: value, ack: true }).catch(() => {
            /* states DB going down — never crash the poll loop */
          });
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
   * Build the provider for one account, resolving its credential from the central
   * storage. Accounts whose provider is not implemented yet, or whose credential
   * cannot be read, are skipped (the engine logs the skip).
   *
   * @param account the validated account config
   * @returns the provider, or undefined to skip the account
   */
  private async makeProvider(account: AccountConfig): Promise<UsageProvider | undefined> {
    switch (account.provider) {
      case "claude-sub":
        return claudeSubProvider(this.claudeTokenStore(account.id), undefined, postJson);
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
      const values = credential.values as { key?: unknown; password?: unknown };
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
   * Delete the object trees of accounts that are no longer in the table. Disabled
   * rows keep their tree (they are only paused); an EMPTY table deletes nothing —
   * the guard against wiping everything through an accidental clear.
   */
  private async cleanupStaleAccounts(): Promise<void> {
    const keepIds = validAccountIds(this.config.accounts);
    if (keepIds.length === 0) {
      return;
    }
    const keep = new Set([...keepIds, "info", "total", "auth"]);
    try {
      const objects = await this.getAdapterObjectsAsync();
      const roots = new Set<string>();
      for (const id of Object.keys(objects)) {
        const relative = id.substring(this.namespace.length + 1);
        const root = relative.split(".")[0];
        if (root && !keep.has(root)) {
          roots.add(root);
        }
      }
      for (const root of roots) {
        this.log.info(`Removing objects of no longer configured account "${root}"`);
        await this.delObjectAsync(root, { recursive: true });
      }
    } catch (e) {
      this.log.warn(`Cleanup of stale accounts failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Tear down synchronously — no async/await here, else the controller kills the
   * process before cleanup finishes.
   *
   * @param callback invoked when cleanup is done
   */
  private onUnload(callback: () => void): void {
    try {
      this.engine?.stop();
      this.engine = null;
      void this.setState("info.connection", { val: false, ack: true });
    } catch {
      // never block shutdown
    }
    callback();
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new AiUsageAdapter(options);
} else {
  (() => new AiUsageAdapter())();
}

import * as utils from "@iobroker/adapter-core";
import { Credentials } from "@iobroker/adapter-core";
import { PollEngine } from "./lib/poll-engine";
import { clampPollInterval, parseAccounts, validAccountIds, type AccountConfig } from "./lib/pure-helpers";
import type { UsageProvider } from "./lib/provider";
import { deepSeekProvider } from "./lib/providers/deepseek";
import { openRouterProvider } from "./lib/providers/openrouter";

/** A cancellable handle: interval or timeout — the engine treats them uniformly. */
type TimerHandle =
  | { kind: "interval"; handle: ioBroker.Interval | undefined }
  | { kind: "timeout"; handle: ioBroker.Timeout | undefined };

/**
 * AI Usage adapter — polls the usage/limit/cost sources of configured AI accounts
 * (Claude subscription, OpenRouter, DeepSeek, OpenAI API, Anthropic API, GitHub
 * Copilot) and mirrors them into read-only states. Orchestration lives in the
 * fully unit-tested {@link PollEngine}; this class only wires ioBroker IO to it.
 */
export class AiUsageAdapter extends utils.Adapter {
  private engine: PollEngine | null = null;

  /**
   * @param options the adapter options
   */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "ai-usage" });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /** Validate the configuration, clean up stale account trees and start the engine. */
  private async onReady(): Promise<void> {
    try {
      const accounts = parseAccounts(this.config.accounts);
      const interval = clampPollInterval(this.config.pollInterval);
      await this.cleanupStaleAccounts();
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
      case "openrouter": {
        const key = await this.resolveKey(account);
        return key ? openRouterProvider(key) : undefined;
      }
      case "deepseek": {
        const key = await this.resolveKey(account);
        return key ? deepSeekProvider(key) : undefined;
      }
      default:
        // claude-sub / openai / anthropic-api / copilot land in the next build phases.
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
    const keep = new Set([...keepIds, "info", "total"]);
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

import * as utils from "@iobroker/adapter-core";
import { clampPollInterval, parseAccounts, type AccountConfig } from "./lib/pure-helpers";

/**
 * AI Usage adapter — polls the usage/limit/cost sources of configured AI accounts
 * (Claude subscription, OpenRouter, DeepSeek, OpenAI API, Anthropic API, GitHub
 * Copilot) and mirrors them into read-only states. Exported so orchestration unit
 * tests can drive its lifecycle directly.
 */
export class AiUsageAdapter extends utils.Adapter {
  /** The validated, enabled accounts from the admin table. */
  private accounts: AccountConfig[] = [];
  /** Per-account poll timers (cleared synchronously in onUnload). */
  private readonly pollTimers: ioBroker.Interval[] = [];

  /**
   * @param options the adapter options
   */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "ai-usage" });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /** Validate the configuration and start one poll cycle per account. */
  private async onReady(): Promise<void> {
    try {
      this.accounts = parseAccounts(this.config.accounts);
      const interval = clampPollInterval(this.config.pollInterval);
      if (this.accounts.length === 0) {
        this.log.info("No AI accounts configured — add accounts in the instance settings");
      } else {
        this.log.info(`Monitoring ${this.accounts.length} AI account(s), polling every ${interval} s`);
      }
      await this.setState("info.connection", { val: false, ack: true });
      // The per-account poll engine lands with the provider modules; the skeleton
      // only proves lifecycle + config handling.
    } catch (e) {
      this.log.error(`Startup failed: ${e instanceof Error ? e.message : String(e)}`);
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
      for (const timer of this.pollTimers) {
        this.clearInterval(timer);
      }
      this.pollTimers.length = 0;
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

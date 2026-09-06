// Augment the ioBroker adapter config with this adapter's native settings.
// Keep this in sync with io-package.json "native".
declare global {
  namespace ioBroker {
    interface AdapterConfig {
      /** Configured AI accounts — one row per switched-on account. */
      accounts: {
        /** Display name, shown in the settings and in the account's node name. */
        name: string;
        /**
         * Provider kind: claude-sub, chatgpt-sub, gemini-sub, openrouter, deepseek,
         * openai or anthropic-api. The catalogue in `lib/provider.ts` is the source.
         */
        provider: string;
        /** Id of the central credential (system.credentials.*); empty for the subscriptions. */
        credentialId: string;
        /** Warn threshold in percent (default 80). */
        warnThreshold: number;
      }[];
      /** Poll interval in seconds (min 60, default 300). */
      pollInterval: number;
      /** Whether to raise ioBroker notifications on threshold/auth problems. */
      notifications: boolean;
    }
  }
}

export {};

// Augment the ioBroker adapter config with this adapter's native settings.
// Keep this in sync with io-package.json "native".
declare global {
  namespace ioBroker {
    interface AdapterConfig {
      /** Configured AI accounts (admin table). */
      accounts: {
        /** Display name; becomes the object id (sanitized). */
        name: string;
        /** Provider kind (claude-sub, openrouter, deepseek, openai, anthropic-api). */
        provider: string;
        /** Id of the central credential (system.credentials.*); empty for claude-sub. */
        credentialId: string;
        /** Warn threshold in percent (default 80). */
        warnThreshold: number;
        /** Whether this account is polled. */
        enabled: boolean;
      }[];
      /** Poll interval in seconds (min 60, default 300). */
      pollInterval: number;
      /** Whether to raise ioBroker notifications on threshold/auth problems. */
      notifications: boolean;
    }
  }
}

export {};

/** One configured AI account, validated from the admin table (API boundary). */
export interface AccountConfig {
  /** Display name from the table. */
  name: string;
  /** Id-safe object id derived from the name. */
  id: string;
  /** Provider kind. */
  provider: string;
  /** Central credential id (system.credentials.*); empty for claude-sub. */
  credentialId: string;
  /** Warn threshold in percent. */
  warnThreshold: number;
}

/**
 * Make a string safe as an ioBroker object-id segment.
 *
 * @param name the raw name
 * @returns the sanitized id segment
 */
export function sanitizeId(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The provider kinds the adapter knows. */
export const PROVIDER_KINDS = ["claude-sub", "openrouter", "deepseek", "openai", "anthropic-api", "copilot"];

/**
 * Parse and validate the admin accounts table. Rows without a usable name or with an
 * unknown provider are skipped (type-guarded — the table is external input); disabled
 * rows are skipped too. Duplicate ids keep the first row.
 *
 * @param raw the native.accounts value
 * @returns the validated, enabled accounts
 */
export function parseAccounts(raw: unknown): AccountConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const accounts: AccountConfig[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    if (row.enabled === false) {
      continue;
    }
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const id = sanitizeId(name);
    const provider = typeof row.provider === "string" ? row.provider : "";
    if (!id || id === "info" || id === "total" || !PROVIDER_KINDS.includes(provider) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const threshold = Number(row.warnThreshold);
    accounts.push({
      name,
      id,
      provider,
      credentialId: typeof row.credentialId === "string" ? row.credentialId : "",
      warnThreshold: Number.isFinite(threshold) && threshold >= 10 && threshold <= 100 ? threshold : 80,
    });
  }
  return accounts;
}

/**
 * The ids of ALL valid table rows — including disabled ones. Used by the stale-object
 * cleanup: a disabled account is paused, not deleted; only rows removed from the
 * table lose their tree.
 *
 * @param raw the native.accounts value
 * @returns the id-safe ids of every valid row
 */
export function validAccountIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const id = sanitizeId(typeof row.name === "string" ? row.name : "");
    if (id && id !== "info" && id !== "total" && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Clamp the poll interval to the safe range: minimum 60 s (provider throttling locks
 * whole accounts), default 300 s for anything unusable.
 *
 * @param raw the configured value
 * @returns the effective interval in seconds
 */
export function clampPollInterval(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return 300;
  }
  return Math.min(3600, Math.max(60, Math.round(value)));
}

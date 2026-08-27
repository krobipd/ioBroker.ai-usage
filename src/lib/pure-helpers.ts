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
export const PROVIDER_KINDS = [
  "claude-sub",
  "chatgpt-sub",
  "gemini-sub",
  "openrouter",
  "deepseek",
  "openai",
  "anthropic-api",
];

/** Fixed object id per subscription — adapter-owned, never derived from a display name. */
export const SUBSCRIPTION_IDS: Record<string, string> = {
  "claude-sub": "claude",
  "chatgpt-sub": "chatgpt",
  "gemini-sub": "gemini",
};

/** Top-level object roots the adapter owns — no account may use them as id. */
export const RESERVED_ROOT_IDS = ["info", "total"];

/**
 * The object id of one account. Deterministic and stable: a subscription always owns
 * its provider id, a key-based account always carries the "-api" suffix. Neither
 * depends on a display name, so an id never moves when the user renames something
 * or adds an unrelated credential later.
 *
 * @param provider the provider kind
 * @param credentialId the central credential id (key-based accounts)
 * @returns the id-safe object id, or "" when it cannot be formed
 */
export function accountId(provider: string, credentialId: string): string {
  const fixed = SUBSCRIPTION_IDS[provider];
  if (fixed) {
    return fixed;
  }
  const suffix = sanitizeId(credentialId.replace(/^system\.credentials\./, ""));
  return suffix ? `${suffix}-api` : "";
}

/**
 * Parse and validate the admin accounts table. Rows without a usable name or with an
 * unknown provider are skipped (type-guarded — the table is external input).
 * Duplicate ids keep the first row.
 *
 * A row exists exactly as long as its switch is on: switching an account off removes
 * the row, which is also what lets the stale-object cleanup work off this one list.
 *
 * @param raw the native.accounts value
 * @returns the validated accounts
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
    const provider = typeof row.provider === "string" ? row.provider : "";
    const credentialId = typeof row.credentialId === "string" ? row.credentialId : "";
    const id = accountId(provider, credentialId);
    const name = (typeof row.name === "string" ? row.name.trim() : "") || id;
    if (!id || RESERVED_ROOT_IDS.includes(id) || !PROVIDER_KINDS.includes(provider) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const threshold = Number(row.warnThreshold);
    accounts.push({
      name,
      id,
      provider,
      credentialId,
      warnThreshold: Number.isFinite(threshold) && threshold >= 10 && threshold <= 100 ? threshold : 80,
    });
  }
  return accounts;
}

/**
 * Round to two decimals — money and percent are displayed, not calculated with.
 *
 * @param value the value
 * @returns the rounded value
 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A finite number out of untrusted input, or undefined for anything else.
 *
 * Providers deliver amounts as strings ("110.00"), as numbers, as null for
 * "unlimited" and occasionally as an empty string — all of which `Number()` alone
 * turns into 0 or NaN. Only a real number gets through here.
 *
 * @param value the raw value
 * @returns the number, or undefined
 */
export function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
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

/**
 * The one-line balance of what the object tree gained and lost, or null when
 * nothing changed.
 *
 * Silence at 0/0 is the point: a normal restart must not write anything, otherwise
 * the line becomes noise and stops being read (fleet standard, beszel).
 *
 * @param created datapoints added since the snapshot
 * @param removed datapoints deleted since the snapshot
 * @returns the log line, or null when there is nothing to report
 */
export function datapointBalanceLine(created: number, removed: number): string | null {
  const parts: string[] = [];
  if (created > 0) {
    parts.push(`created ${created} datapoint(s)`);
  }
  if (removed > 0) {
    parts.push(`removed ${removed} datapoint(s)`);
  }
  return parts.length ? `Object tree updated: ${parts.join(", ")}` : null;
}

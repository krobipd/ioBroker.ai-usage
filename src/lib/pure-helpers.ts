import { PROVIDERS, type ProviderKind } from "./provider";

/** One configured AI account, validated from the admin table (API boundary). */
export interface AccountConfig {
  /** Display name from the table. */
  name: string;
  /** The account's fixed object id. */
  id: string;
  /** Provider kind — validated against the catalogue, so no `default` branch can be reached. */
  provider: ProviderKind;
  /** Central credential id (system.credentials.*); empty for the subscriptions. */
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

/** The provider kinds the adapter knows — derived from the catalogue in `provider.ts`. */
export const PROVIDER_KINDS: readonly string[] = PROVIDERS.map(entry => entry.kind);

/** Fixed object id per subscription — adapter-owned, never derived from a display name. */
export const SUBSCRIPTION_IDS: Record<string, string> = Object.fromEntries(
  PROVIDERS.filter(entry => entry.accountId !== undefined).map(entry => [entry.kind, entry.accountId as string]),
);

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

/** A configured row the parser could not use, with the reason a user can act on. */
export interface DiscardedRow {
  /** What the row calls itself — name, credential or provider, whichever there is. */
  label: string;
  /** Why it was dropped, in plain words. */
  reason: string;
}

/** What {@link parseAccounts} makes of the table: what it took, and what it dropped. */
export interface ParsedAccounts {
  /** The usable accounts, in table order. */
  accounts: AccountConfig[];
  /** The rows that were dropped — one warning each, so nothing disappears silently. */
  discarded: DiscardedRow[];
}

/**
 * Parse and validate the admin accounts table (type-guarded — the table is external
 * input). Duplicate ids keep the first row. Every row that cannot be used comes back
 * in `discarded` with the reason, so the startup can say what it dropped instead of
 * counting only the survivors.
 *
 * A row exists exactly as long as its switch is on: switching an account off removes
 * the row, which is also what lets the stale-object cleanup work off this one list.
 *
 * Unknown keys are ignored, not rejected — rows written by an older version still
 * carry an `enabled` flag from the table days. It is inert (presence of the row IS
 * the switch), and stripping it would mean rewriting the user's config, which
 * restarts the instance for no gain.
 *
 * @param raw the native.accounts value
 * @returns the usable accounts plus the rows that were dropped, with reasons
 */
export function parseAccounts(raw: unknown): ParsedAccounts {
  if (!Array.isArray(raw)) {
    return { accounts: [], discarded: [] };
  }
  const accounts: AccountConfig[] = [];
  const discarded: DiscardedRow[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      discarded.push({ label: String(entry), reason: "the row is not a table entry" });
      continue;
    }
    const row = entry as Record<string, unknown>;
    const provider = typeof row.provider === "string" ? row.provider : "";
    const credentialId = typeof row.credentialId === "string" ? row.credentialId : "";
    const id = accountId(provider, credentialId);
    const name = (typeof row.name === "string" ? row.name.trim() : "") || id;
    // Every reason is named. A row that silently vanished left the user with a
    // start line counting only what survived — three rows in, one account out, and
    // nothing in the log to say why.
    const label = name || credentialId || provider || "(unnamed row)";
    if (!PROVIDER_KINDS.includes(provider)) {
      discarded.push({ label, reason: `unknown provider "${provider}"` });
      continue;
    }
    if (!id) {
      discarded.push({ label, reason: "no usable object id — pick a credential for this row" });
      continue;
    }
    // Unreachable with today's id scheme — a subscription owns a fixed id and a key
    // account always ends in "-api", so neither can become `info` or `total`. Kept
    // as the guard on the adapter's own roots for the day that scheme changes.
    if (RESERVED_ROOT_IDS.includes(id)) {
      discarded.push({ label, reason: `the id "${id}" is reserved by the adapter` });
      continue;
    }
    if (seen.has(id)) {
      discarded.push({ label, reason: `another row already uses the id "${id}"` });
      continue;
    }
    seen.add(id);
    const threshold = Number(row.warnThreshold);
    accounts.push({
      name,
      id,
      provider: provider as ProviderKind,
      credentialId,
      warnThreshold: Number.isFinite(threshold) && threshold >= 10 && threshold <= 100 ? threshold : 80,
    });
  }
  return { accounts, discarded };
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

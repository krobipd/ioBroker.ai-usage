import { PROVIDERS } from "../../src/lib/provider.js";
import { accountId, clampThreshold } from "../../src/lib/pure-helpers.js";

/**
 * The adapter's own rules, imported — not copied. The panel used to carry a second
 * copy of the id rule, the provider list and the threshold clamp, and the threshold
 * copy did drift (the page clamped, the adapter fell back to 80). A relative import
 * lands in the Module-Federation bundle like any other source (fleet rule,
 * `admin-component.md`); both modules are free of Node imports.
 */
export { accountId };

/** The eleven languages this adapter ships — the i18n files under `src/i18n/`. */
const SUPPORTED_LANGUAGES = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"] as const;

/**
 * Pick the shipped language closest to what the browser reports.
 *
 * The browser can report anything (`sv-SE`, `cs`, an empty string); handing that
 * straight to `setLanguage` used to compile only because a type suppression turned
 * the whole expression into `any` — it was never checked against what we actually
 * ship. Anything we do not have falls back to English.
 *
 * @param reported what `navigator.language` says
 * @returns one of the shipped languages
 */
export function supportedLanguage(reported: string | undefined): ioBroker.Languages {
  const lower = (reported || "en").toLowerCase();
  const candidate = lower.startsWith("zh") ? "zh-cn" : lower.substring(0, 2);
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(candidate) ? (candidate as ioBroker.Languages) : "en";
}

/** One row of the adapter's `native.accounts` (kept compatible with the backend parser). */
export interface AccountRow {
  name: string;
  provider: string;
  credentialId: string;
  warnThreshold: number;
}

/** One entry of the admin's central credential storage (category "AI"). */
export interface CredentialEntry {
  /** Full object id (system.credentials.<name>). */
  id: string;
  /** The id suffix. */
  suffix: string;
  /** Display name. */
  name: string;
  /** Icon data URL from the storage, if any. */
  icon?: string;
}

/** How a key-based provider is offered for a stored credential. */
export interface KeyProviderOffer {
  /** The provider kind to store in the row. */
  provider: string;
  /** Label shown in the row. */
  label: string;
  /** Why this row may need a different key than the one the assistant uses. */
  needsAdminKey: boolean;
}

/** How a row's service status is shown: which colour, which label. */
export interface ServiceBadge {
  /** Translation key of the label. */
  key: string;
  /** MUI chip colour. */
  color: "success" | "warning" | "error";
  /** The plain-text reason, shown on hover; empty while everything works. */
  title: string;
}

/**
 * Turn an account's two status states into the badge shown in its row.
 *
 * `unreach` is true whenever the account does NOT deliver — no connection, a broken
 * service, a rejected or missing sign-in, a missing key: all red, with the reason.
 * The one amber case is a throttle: the account still counts as delivering (its
 * last values stay valid) and `info.error` says why it waits. Nothing known yet shows
 * nothing at all rather than a guess.
 *
 * @param unreach value of `<account>.info.unreach`
 * @param error value of `<account>.info.error`
 * @returns the badge, or null while the account has never reported
 */
export function serviceBadge(unreach: unknown, error: unknown): ServiceBadge | null {
  if (unreach === undefined || unreach === null) {
    return null;
  }
  const reason = typeof error === "string" ? error : "";
  if (unreach === true) {
    return { key: "aiu_stOffline", color: "error", title: reason };
  }
  if (reason) {
    return { key: "aiu_stLimited", color: "warning", title: reason };
  }
  return { key: "aiu_stOnline", color: "success", title: "" };
}

/** The three subscriptions, in the order the panel lists them. */
export const SUBSCRIPTIONS: { provider: string; label: string; captionKey: string }[] = [
  { provider: "claude-sub", label: "Claude", captionKey: "aiu_capClaude" },
  { provider: "chatgpt-sub", label: "ChatGPT", captionKey: "aiu_capChatgpt" },
  { provider: "gemini-sub", label: "Gemini", captionKey: "aiu_capGemini" },
];

/**
 * Which key-based provider fits a stored credential.
 *
 * The storage only records the category "AI", never the provider, so the template
 * name is the only hint. Anthropic and OpenAI are offered with an explicit warning:
 * their usage reports need an ADMIN key, not the key the admin assistant uses.
 *
 * @param suffix the credential id suffix
 * @param name the display name
 * @returns the offer, or null when nothing fits
 */
export function offerForCredential(suffix: string, name: string): KeyProviderOffer | null {
  const hay = `${suffix} ${name}`.toLowerCase();
  if (hay.includes("gemini")) {
    return null; // no usage endpoint for a plain Gemini key — the subscription row covers Google
  }
  if (hay.includes("anthropic") || hay.includes("claude")) {
    return { provider: "anthropic-api", label: "Anthropic", needsAdminKey: true };
  }
  if (hay.includes("chatgpt") || hay.includes("openai")) {
    return { provider: "openai", label: "OpenAI", needsAdminKey: true };
  }
  if (hay.includes("deepseek")) {
    return { provider: "deepseek", label: "DeepSeek", needsAdminKey: false };
  }
  if (hay.includes("openrouter") || hay.includes("router")) {
    return { provider: "openrouter", label: "OpenRouter", needsAdminKey: false };
  }
  return null;
}

/** Every key-based provider, for the manual picker — from the adapter's one catalogue. */
export const KEY_PROVIDERS: KeyProviderOffer[] = PROVIDERS.filter(entry => entry.flow === undefined).map(entry => ({
  provider: entry.kind,
  label: entry.label,
  needsAdminKey: entry.needsAdminKey === true,
}));

/**
 * The row of one subscription, if it is switched on.
 *
 * @param rows the configured rows
 * @param provider the subscription kind
 * @returns the row or undefined
 */
export function subscriptionRow(rows: AccountRow[], provider: string): AccountRow | undefined {
  return rows.find(row => row.provider === provider);
}

/**
 * Switch a subscription on or off.
 *
 * @param rows the configured rows
 * @param provider the subscription kind
 * @param on the new state
 * @param label the display name to store
 * @returns the new rows
 */
export function toggleSubscription(rows: AccountRow[], provider: string, on: boolean, label: string): AccountRow[] {
  const rest = rows.filter(row => row.provider !== provider);
  if (!on) {
    return rest;
  }
  return [...rest, { name: label, provider, credentialId: "", warnThreshold: 80 }];
}

/**
 * Switch monitoring of one stored credential on or off.
 *
 * @param rows the configured rows
 * @param credential the storage entry
 * @param provider the provider kind to use
 * @param on the new state
 * @returns the new rows
 */
export function toggleCredential(
  rows: AccountRow[],
  credential: CredentialEntry,
  provider: string,
  on: boolean,
): AccountRow[] {
  const rest = rows.filter(row => row.credentialId !== credential.id);
  if (!on || !provider) {
    return rest;
  }
  return [...rest, { name: credential.name, provider, credentialId: credential.id, warnThreshold: 80 }];
}

/**
 * Change the warn threshold of one row, clamped to the range the backend accepts.
 *
 * @param rows the configured rows
 * @param match how to find the row
 * @param match.provider
 * @param match.credentialId
 * @param raw the raw input value
 * @returns the new rows
 */
export function setThreshold(
  rows: AccountRow[],
  match: { provider?: string; credentialId?: string },
  raw: string,
): AccountRow[] {
  // The adapter's own rule — the copy that lived here clamped while the adapter fell back to 80.
  const value = clampThreshold(raw);
  return rows.map(row => {
    const hit = match.credentialId ? row.credentialId === match.credentialId : row.provider === match.provider;
    return hit ? { ...row, warnThreshold: value } : row;
  });
}

/**
 * Rows that are switched on but whose stored key is gone from the credential storage.
 *
 * The page drew key rows only from the storage, so such a row was invisible — it
 * could not even be switched off, while the adapter warned on every start and
 * `info.error` asked the user to pick a key on a page that showed nothing to pick
 * (decision 105).
 *
 * @param rows the configured rows
 * @param credentials what the storage holds
 * @returns the key rows without a matching storage entry
 */
export function orphanRows(rows: AccountRow[], credentials: CredentialEntry[]): AccountRow[] {
  const known = new Set(credentials.map(entry => entry.id));
  return rows.filter(
    row => !SUBSCRIPTIONS.some(entry => entry.provider === row.provider) && !known.has(row.credentialId),
  );
}

/** What the credential part of the page shows. */
export type CredentialListState = "loading" | "unreadable" | "empty" | "list";

/**
 * What the credential part of the page shows.
 *
 * A failed read is not "nothing stored": saying so hid every switched-on key row
 * behind "no AI credentials stored yet" — the same mistake the sign-in status had
 * made with a transport miss (krobi, live 2026-09-01), in its second place.
 *
 * @param loaded whether the read finished
 * @param failed whether it failed
 * @param count how many entries it brought
 * @returns the state
 */
export function credentialListState(loaded: boolean, failed: boolean, count: number): CredentialListState {
  if (!loaded) {
    return "loading";
  }
  if (failed) {
    return "unreadable";
  }
  return count === 0 ? "empty" : "list";
}

/**
 * How long the page waits for the adapter's answer to one command (ms).
 *
 * `socket.sendTo` itself never gives up (socket-client 5.2.1: `commandTimeout:
 * false`), so without a deadline a lost answer left a button spinning until the page
 * was reloaded. The actions get longer: the adapter itself may wait up to 15 s for
 * the provider inside them (decision 106).
 *
 * @param command the message command
 * @returns the deadline
 */
export function answerDeadline(command: string): number {
  return command === "signInStatus" ? 10_000 : 30_000;
}

/**
 * A promise that settles with `null` once the deadline passed.
 *
 * @param promise what to wait for
 * @param ms the deadline
 * @returns the result, or null when it came too late
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** What decides whether the page must ask for the sign-in status again. */
export interface PanelFacts {
  /** Whether the instance runs. */
  alive: boolean;
  /** Whether the form has unsaved changes. */
  changed: boolean;
  /** The switched-on subscriptions. */
  subscriptions: string[];
}

/**
 * Whether the page must ask for the sign-in status at once.
 *
 * After starting the instance, after saving, or when a subscription was switched
 * on, the answer is new — waiting for the 30-second beat left a spinner (or a stale
 * paste form of an attempt the restarted adapter no longer knows) standing that long.
 *
 * @param before the facts before the update
 * @param after the facts after it
 * @returns true when the status has to be asked now
 */
export function needsSignInRefresh(before: PanelFacts, after: PanelFacts): boolean {
  return (
    (!before.alive && after.alive) ||
    (before.changed && !after.changed) ||
    before.subscriptions.join("|") !== after.subscriptions.join("|")
  );
}

/**
 * Merge status answers into the known states — older answers never win.
 *
 * A status round that started before a user action may come back after it; its
 * answer described the old state and put the paste form or "signed in" back over
 * what the action had just shown. Every provider carries a sequence number that each
 * action raises; an answer from before the current number is dropped.
 *
 * @param known the states shown now
 * @param answers the answers of one status round, with the sequence each was asked at
 * @param current the current sequence per provider
 * @returns the merged states
 */
export function mergeSignIn<S>(
  known: Record<string, S>,
  answers: { provider: string; answer: S | null; sequence: number }[],
  current: Record<string, number>,
): Record<string, S> {
  const merged = { ...known };
  for (const { provider, answer, sequence } of answers) {
    if (answer && sequence === (current[provider] ?? 0)) {
      merged[provider] = answer;
    }
  }
  return merged;
}

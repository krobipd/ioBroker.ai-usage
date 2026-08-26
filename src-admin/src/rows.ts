/** One row of the adapter's `native.accounts` (kept compatible with the backend parser). */
export interface AccountRow {
    name: string;
    provider: string;
    credentialId: string;
    warnThreshold: number;
    enabled: boolean;
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

/** Fixed object id per subscription — must match `SUBSCRIPTION_IDS` in the adapter. */
const SUBSCRIPTION_IDS: Record<string, string> = {
    'claude-sub': 'claude',
    'chatgpt-sub': 'chatgpt',
    'gemini-sub': 'gemini',
};

/**
 * The object id of one account — the same rule the adapter uses in `pure-helpers.ts`.
 *
 * Kept as a second copy on purpose: the admin panel is its own bundle and cannot
 * import from the adapter's sources. Both sides must change together, which is why
 * the rule is deliberately tiny.
 *
 * @param provider the provider kind
 * @param credentialId the central credential id, for key-based accounts
 * @returns the id, or an empty string when nothing fits
 */
export function accountId(provider: string, credentialId: string): string {
    const fixed = SUBSCRIPTION_IDS[provider];
    if (fixed) {
        return fixed;
    }
    const suffix = credentialId
        .replace(/^system\.credentials\./, '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '');
    return suffix ? `${suffix}-api` : '';
}

/** How a row's service status is shown: which colour, which label. */
export interface ServiceBadge {
    /** Translation key of the label. */
    key: string;
    /** MUI chip colour. */
    color: 'success' | 'warning' | 'error';
    /** The plain-text reason, shown on hover; empty while everything works. */
    title: string;
}

/**
 * Turn an account's two status states into the badge shown in its row.
 *
 * `unreach` is the AI service itself being unreachable — that is the red case. A
 * rejected sign-in or a throttle leave the service reachable but stop the data, so
 * they are amber with the reason on hover. Nothing known yet shows nothing at all
 * rather than a guess.
 *
 * @param unreach value of `<account>.info.unreach`
 * @param error value of `<account>.info.error`
 * @returns the badge, or null while the account has never reported
 */
export function serviceBadge(unreach: unknown, error: unknown): ServiceBadge | null {
    if (unreach === undefined || unreach === null) {
        return null;
    }
    const reason = typeof error === 'string' ? error : '';
    if (unreach === true) {
        return { key: 'aiu_stOffline', color: 'error', title: reason };
    }
    if (reason) {
        return { key: 'aiu_stLimited', color: 'warning', title: reason };
    }
    return { key: 'aiu_stOnline', color: 'success', title: '' };
}

/** The three subscriptions, in the order the panel lists them. */
export const SUBSCRIPTIONS: { provider: string; label: string; captionKey: string }[] = [
    { provider: 'claude-sub', label: 'Claude', captionKey: 'aiu_capClaude' },
    { provider: 'chatgpt-sub', label: 'ChatGPT', captionKey: 'aiu_capChatgpt' },
    { provider: 'gemini-sub', label: 'Gemini', captionKey: 'aiu_capGemini' },
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
    if (hay.includes('gemini')) {
        return null; // no usage endpoint for a plain Gemini key — the subscription row covers Google
    }
    if (hay.includes('anthropic') || hay.includes('claude')) {
        return { provider: 'anthropic-api', label: 'Anthropic', needsAdminKey: true };
    }
    if (hay.includes('chatgpt') || hay.includes('openai')) {
        return { provider: 'openai', label: 'OpenAI', needsAdminKey: true };
    }
    if (hay.includes('deepseek')) {
        return { provider: 'deepseek', label: 'DeepSeek', needsAdminKey: false };
    }
    if (hay.includes('openrouter') || hay.includes('router')) {
        return { provider: 'openrouter', label: 'OpenRouter', needsAdminKey: false };
    }
    return null;
}

/** Every key-based provider, for the manual picker when the name gives nothing away. */
export const KEY_PROVIDERS: KeyProviderOffer[] = [
    { provider: 'openrouter', label: 'OpenRouter', needsAdminKey: false },
    { provider: 'deepseek', label: 'DeepSeek', needsAdminKey: false },
    { provider: 'openai', label: 'OpenAI', needsAdminKey: true },
    { provider: 'anthropic-api', label: 'Anthropic', needsAdminKey: true },
];

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
    return [...rest, { name: label, provider, credentialId: '', warnThreshold: 80, enabled: true }];
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
    return [...rest, { name: credential.name, provider, credentialId: credential.id, warnThreshold: 80, enabled: true }];
}

/**
 * Change the warn threshold of one row, clamped to the range the backend accepts.
 *
 * @param rows the configured rows
 * @param match how to find the row
 * @param raw the raw input value
 * @returns the new rows
 */
export function setThreshold(
    rows: AccountRow[],
    match: { provider?: string; credentialId?: string },
    raw: string,
): AccountRow[] {
    const value = Math.min(100, Math.max(10, Math.round(Number(raw)) || 80));
    return rows.map(row => {
        const hit = match.credentialId ? row.credentialId === match.credentialId : row.provider === match.provider;
        return hit ? { ...row, warnThreshold: value } : row;
    });
}

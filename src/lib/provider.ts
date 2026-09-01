/** The provider kinds the adapter speaks. */
export type ProviderKind =
  "claude-sub" | "chatgpt-sub" | "gemini-sub" | "openrouter" | "deepseek" | "openai" | "anthropic-api";

/**
 * How a subscription account is signed in. Each provider dictates its own flow —
 * the admin panel renders the matching instructions, the adapter drives the rest.
 *
 * - `paste-code`: the user opens a link, signs in and pastes the code shown there (Claude).
 * - `device-code`: the adapter shows a short code the user types on the provider's page,
 *   then polls until the user confirmed (ChatGPT/Codex).
 * - `paste-url`: the user opens a link, signs in and lands on a browser error page whose
 *   ADDRESS carries the code — the whole address is pasted back (Gemini, the only redirect
 *   Google accepts for the usable client; measured 2026-08-26).
 */
export type SignInFlow = "paste-code" | "device-code" | "paste-url";

/** One limit window (session, week, per-model) — the same shape for every provider. */
export interface LimitWindow {
  /** Window name; becomes the object id segment (session, week, a model name, month). */
  name: string;
  /** Human-readable label for the object name. */
  label: string;
  /** Utilisation in percent (0-100+). */
  percent: number;
  /** When the window resets (ISO timestamp), if the source reports it. */
  resetAt?: string;
  /**
   * True when this window covers only a PART of the plan — a single model or
   * surface that sits next to a plan-wide window of the same period.
   *
   * Such a bucket is reported as its own datapoint but never drives the account's
   * warning: a model the user does not use can sit at 100 % forever, and a counter
   * that never falls is worse than no counter (krobi 2026-08-26: "das betrifft nur
   * Fable, nicht allgemein"). Providers whose ONLY buckets are per-model (Google)
   * leave this unset — there the model buckets are the plan.
   */
  scoped?: boolean;
}

/** Granted budget (prepaid money or request credits). */
export interface CreditInfo {
  /** Used amount. */
  used?: number;
  /** Granted ceiling; undefined = unlimited/unknown. */
  limit?: number;
  /** Remaining amount. */
  remaining?: number;
  /** Utilisation in percent, when both used and limit are known. */
  percent?: number;
  /** Granted (gifted) part of the balance, where the source distinguishes it (DeepSeek). */
  granted?: number;
  /** Topped-up (paid) part of the balance. */
  toppedUp?: number;
  /** Currency code ("USD", "CNY") — or a unit word for piece-counters. */
  currency: string;
  /** True when the credits are pieces (requests), not money — excluded from cost totals. */
  pieces?: boolean;
  /**
   * Purchasable limit-reset vouchers currently available (ChatGPT/Codex "rate limit
   * reset credits"). A count of pieces, never money.
   */
  resetCredits?: number;
  /**
   * When the next available reset voucher expires (ISO timestamp); empty string
   * while none is held — the datapoint stays, only its value empties.
   */
  resetCreditsNextExpiry?: string;
}

/** Real money spent. */
export interface CostInfo {
  /** Spent today. */
  today?: number;
  /** Spent this month (or billing period). */
  month?: number;
  /** Lifetime counter, where the source only reports that. */
  total?: number;
  /** Projected month-end spend (computed by the provider module, marked in the object name). */
  projectedMonth?: number;
  /** Currency code. */
  currency: string;
}

/** Token counters (API accounts). */
export interface TokenInfo {
  /** Input tokens today. */
  inputToday?: number;
  /** Output tokens today. */
  outputToday?: number;
  /** Per-model breakdown. */
  perModel?: { model: string; tokens?: number; cost?: number }[];
}

/**
 * A transport-neutral usage snapshot — one fetch result. Only what the source
 * actually delivered is present. The tree builder creates nothing for absent
 * PARTS (a missing credits/costs/tokens block), but inside a delivered part the
 * time-stamp companions always exist, and existing datapoints outlive a
 * momentary omission — see snapshot-tree.ts.
 */
export interface UsageSnapshot {
  /** Limit windows (subscription accounts). */
  limits?: LimitWindow[];
  /** Granted budget. */
  credits?: CreditInfo;
  /** Real money spent. */
  costs?: CostInfo;
  /** Token counters. */
  tokens?: TokenInfo;
  /** Provider-specific extra flags (e.g. DeepSeek `available`). */
  available?: boolean;
}

/**
 * Why a fetch failed — drives reachability, backoff and notifications.
 *
 * `auth` and `rate-limit` mean the AI service ANSWERED (it is online, it just said
 * no), `service` means it answered with a server fault of its own, and `network`
 * means we never reached it. Keeping the last two apart is what lets the adapter
 * say whether the AI service is down or the ioBroker host has no connection.
 */
export type FetchErrorKind = "auth" | "rate-limit" | "service" | "network";

/** A typed fetch failure. */
export class FetchError extends Error {
  /**
   * @param kind the failure class
   * @param message the human-readable reason
   */
  public constructor(
    public readonly kind: FetchErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/** One account's usage source. Implementations are pure fetch+parse — no ioBroker inside. */
export interface UsageProvider {
  /** Which provider this is. */
  readonly kind: ProviderKind;
  /** Fetch the current snapshot; throws {@link FetchError} on failure. */
  fetch(): Promise<UsageSnapshot>;
}

/** Persisted OAuth tokens of one subscription account. */
export interface TokenSet {
  /** The bearer token used for the usage call. */
  accessToken: string;
  /** The token used to obtain a fresh access token. */
  refreshToken: string;
  /** Absolute expiry of {@link accessToken} in ms since epoch. */
  expiresAt: number;
  /** Provider-specific extra the usage call needs (e.g. ChatGPT account id). */
  accountRef?: string;
}

/** Where a subscription's tokens live. Keyed by PROVIDER, never by account name. */
export interface TokenStore {
  /** Read the stored tokens, or null when never signed in. */
  load(): Promise<TokenSet | null>;
  /** Persist tokens (encrypted by the adapter). */
  save(tokens: TokenSet): Promise<void>;
  /** Forget the tokens (sign out / unusable refresh token). */
  clear(): Promise<void>;
}

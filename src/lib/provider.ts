/** The provider kinds the adapter speaks. */
export type ProviderKind = "claude-sub" | "openrouter" | "deepseek" | "openai" | "anthropic-api" | "copilot";

/** One limit window (session, week, per-model, month) — the same shape for every provider. */
export interface LimitWindow {
  /** Window name; becomes the object id segment (session, week, a model name, month). */
  name: string;
  /** Human-readable label for the object name. */
  label: string;
  /** Utilisation in percent (0-100+). */
  percent: number;
  /** When the window resets (ISO timestamp), if the source reports it. */
  resetAt?: string;
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
 * actually delivered is present; the tree builder creates nothing for absent parts.
 */
export interface UsageSnapshot {
  /** Limit windows (subscription accounts, Copilot month). */
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

/** Why a fetch failed — drives reachability, backoff and notifications. */
export type FetchErrorKind = "auth" | "rate-limit" | "network";

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

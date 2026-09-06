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

/** One entry of the provider catalogue. */
export interface ProviderEntry {
  /** The provider kind — the value stored in the account row. */
  readonly kind: string;
  /** Readable name for log lines and the admin row; never the internal kind. */
  readonly label: string;
  /** How this subscription signs in; absent for key-based accounts. */
  readonly flow?: SignInFlow;
  /** Fixed object id of the subscription's account; key accounts derive theirs from the credential. */
  readonly accountId?: string;
  /** True where the usage report needs an ORGANISATION admin key, not an ordinary API key. */
  readonly needsAdminKey?: boolean;
}

/**
 * Every provider the adapter speaks, in one table.
 *
 * There used to be five: the kind union here, the kind list in `pure-helpers`, the
 * fixed account ids, and the flow and label maps in `sign-in.ts` — five places to
 * keep in step for one new provider, with nothing to catch a miss. Everything below
 * is derived from this table now.
 */
const PROVIDER_TABLE = [
  { kind: "claude-sub", label: "Claude", flow: "paste-code", accountId: "claude" },
  { kind: "chatgpt-sub", label: "ChatGPT", flow: "device-code", accountId: "chatgpt" },
  { kind: "gemini-sub", label: "Gemini", flow: "paste-url", accountId: "gemini" },
  { kind: "openrouter", label: "OpenRouter" },
  { kind: "deepseek", label: "DeepSeek" },
  { kind: "openai", label: "OpenAI", needsAdminKey: true },
  { kind: "anthropic-api", label: "Anthropic", needsAdminKey: true },
] as const;

/** The provider kinds the adapter speaks — derived, so it can never drift from the table. */
export type ProviderKind = (typeof PROVIDER_TABLE)[number]["kind"];

/**
 * The catalogue as a plain list: same entries, widened so the optional fields can
 * be read on every one of them.
 */
export const PROVIDERS: readonly ProviderEntry[] = PROVIDER_TABLE;

/** One limit window (session, week, per-model) — the same shape for every provider. */
export interface LimitWindow {
  /** Window name; becomes the object id segment (session, week, a model name, month). */
  name: string;
  /**
   * English label — for LOG lines and warning messages, which are English fleet-wide.
   * The object name does NOT come from here; see {@link LimitWindow.labelKey}.
   */
  label: string;
  /**
   * i18n key for the window's object name, resolved to the full translation object.
   *
   * The channel of a limit window is an object like any other and must carry all
   * eleven languages (live-tree gate 2026-09-05: "Session (5 h)" and
   * "Week (all models)" sat in the tree as plain English — they are OUR wording, not
   * a name that came from the provider).
   */
  labelKey: string;
  /**
   * The foreign part of the name, where there is one — a model or surface the
   * provider named. It is substituted into the key's `%s` in every language.
   */
  labelArg?: string;
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
  /**
   * True while this window is the one currently in force for the account — the
   * limit the user runs into next.
   *
   * Claude states it per window (`limits[].is_active`, measured 2026-09-06: with
   * Fable at 97 % the model window is active while session at 8 % and week at
   * 54 % are not); where a provider does not, the tree builder marks the window
   * that speaks for the account instead, so the datapoint means the same thing
   * everywhere. It is an indicator only — the account's warning stays on the
   * plan-wide windows (krobi 2026-09-06: "fable 100% ist das fable limit, aber
   * weder das 5h stunden limit noch das wochenlimit").
   */
  active?: boolean;
  /**
   * The provider's own reason for having CLOSED this window, where it says so
   * (Claude's `locked_reason` on the session and week windows).
   *
   * This is the honest answer to "am I locked out", which the adapter otherwise
   * has to guess from `percent >= 100`. It carries no datapoint of its own — it
   * feeds `limitReached` and one log line.
   */
  lockedReason?: string;
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
  /**
   * Per-model breakdown. Tokens only — the cost field that used to sit here had
   * no producer: the OpenAI cost report groups by line item, not by model, so
   * nothing ever filled it and the tree never created the datapoint.
   */
  perModel?: { model: string; tokens?: number }[];
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
 *
 * `no-credentials` is not a failure of the provider at all: nobody has signed in
 * yet, or no API key is selected. It has to stay apart from `auth`, which means a
 * sign-in the provider REJECTED — running the two together greeted a new user with
 * a warning, a notification and a red "the stored sign-in was rejected" before they
 * ever got to the sign-in button, and did the same after every deliberate sign-out.
 */
export type FetchErrorKind = "auth" | "rate-limit" | "service" | "network" | "no-credentials";

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

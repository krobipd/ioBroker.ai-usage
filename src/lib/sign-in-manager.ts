import type { FormPost, JsonPost } from "./http";
import { PROVIDER_LABELS, SIGN_IN_FLOWS, SIGN_IN_WINDOW_MS, attemptExpired, type SignInState } from "./sign-in";
import type { TokenSet, TokenStore } from "./provider";
import { buildAuthorizeUrl, exchangeCode, generatePkce, type PkcePair } from "./providers/claude-auth";
import {
  CHATGPT_OAUTH,
  exchangeDeviceCode,
  pollDeviceCode,
  startDeviceCode,
  type DeviceCodeStart,
} from "./providers/chatgpt-auth";
import {
  buildGeminiAuthorizeUrl,
  exchangeGeminiCode,
  extractGeminiCode,
  generateGeminiPkce,
  type GeminiPkce,
} from "./providers/gemini-auth";

/** One running sign-in attempt (secrets live in memory only, never on disk). */
type Attempt =
  | { flow: "paste-code"; pkce: PkcePair; url: string; expiresAt: number }
  | { flow: "paste-url"; pkce: GeminiPkce; url: string; expiresAt: number }
  | { flow: "device-code"; start: DeviceCodeStart };

/** What the manager needs from the adapter — narrow, so tests need no adapter mock. */
export interface SignInDeps {
  /** The token store of one provider (the adapter owns the file and its encryption). */
  store(provider: string): TokenStore;
  /** JSON POST seam. */
  postJson: JsonPost;
  /** Form POST seam. */
  postForm: FormPost;
  /** Current time (ms since epoch). */
  now(): number;
  /** Arm a repeating callback; returns a cancel handle. */
  schedule(cb: () => void, ms: number): unknown;
  /** Cancel a handle from {@link schedule}. */
  cancel(handle: unknown): void;
  /** Adapter log. */
  log: { info(m: string): void; debug(m: string): void };
  /** Called after tokens were stored — the adapter queries that account at once. */
  onSignedIn(provider: string): void;
}

/**
 * Drives the three sign-in flows and answers what the settings page shows.
 *
 * It lives apart from the adapter for one reason above the tidiness: this is the
 * part of the adapter no gate could reach. The flows are the only path a user
 * touches by hand, two of the three providers were never run against a real
 * account, and the whole orchestration sat inside the adapter class where a test
 * would have needed an ioBroker runtime. Everything here takes its IO from
 * {@link SignInDeps}.
 */
export class SignInManager {
  /** Running attempts, keyed by provider kind. */
  private readonly attempts = new Map<string, Attempt>();
  /** Last failure reason per provider, shown in the admin row. */
  private readonly failures = new Map<string, string>();
  /**
   * Providers whose stored sign-in the provider REJECTED — the tokens are there and
   * no longer work. Reported by the poll engine, never guessed from a file.
   */
  private readonly rejected = new Set<string>();
  /** Device-code pollers, so they can be stopped on unload. */
  private readonly pollers = new Map<string, unknown>();
  /** True while a device-code request is in flight — a second tick must not overlap it. */
  private readonly polling = new Set<string>();

  /**
   * @param deps the injected IO
   */
  public constructor(private readonly deps: SignInDeps) {}

  /**
   * Whether this provider signs in at all.
   *
   * @param provider the provider kind
   * @returns true for the three subscriptions
   */
  public static handles(provider: string): boolean {
    return SIGN_IN_FLOWS[provider] !== undefined;
  }

  /**
   * Report whether a provider's stored sign-in was rejected (from the poll engine).
   *
   * @param provider the provider kind
   * @param rejected true when the last query failed with `auth`
   */
  public setRejected(provider: string, rejected: boolean): void {
    if (rejected) {
      this.rejected.add(provider);
    } else {
      this.rejected.delete(provider);
    }
  }

  /** Stop every device-code poller — for unload. */
  public stopAll(): void {
    for (const provider of [...this.pollers.keys()]) {
      this.stopPoller(provider);
    }
  }

  /**
   * Begin a sign-in: build the link (Claude/Google) or fetch a device code (ChatGPT).
   *
   * @param provider the subscription kind
   * @returns what the admin panel has to show
   */
  public async start(provider: string): Promise<SignInState> {
    this.failures.delete(provider);
    this.rejected.delete(provider);
    this.stopPoller(provider);
    const flow = SIGN_IN_FLOWS[provider];
    const now = this.deps.now();
    try {
      if (flow === "paste-code") {
        const pkce = generatePkce();
        const url = buildAuthorizeUrl(pkce);
        this.attempts.set(provider, { flow, pkce, url, expiresAt: now + SIGN_IN_WINDOW_MS });
        return { status: "awaiting-paste", url, flow };
      }
      if (flow === "paste-url") {
        const pkce = generateGeminiPkce();
        const url = buildGeminiAuthorizeUrl(pkce);
        this.attempts.set(provider, { flow, pkce, url, expiresAt: now + SIGN_IN_WINDOW_MS });
        return { status: "awaiting-paste", url, flow };
      }
      const start = await startDeviceCode(this.deps.postJson, now);
      this.attempts.set(provider, { flow: "device-code", start });
      this.armPoller(provider, start);
      return {
        status: "awaiting-device",
        userCode: start.userCode,
        verificationUrl: CHATGPT_OAUTH.verificationUrl,
        expiresAt: start.expiresAt,
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.failures.set(provider, reason);
      return { status: "failed", reason };
    }
  }

  /**
   * Finish a paste-based sign-in (Claude code, Google address).
   *
   * @param provider the subscription kind
   * @param value what the user pasted
   * @returns the resulting state
   */
  public async submit(provider: string, value: string): Promise<SignInState> {
    const attempt = this.attempts.get(provider);
    const pasted = value.trim();
    if (!attempt || attempt.flow === "device-code") {
      return { status: "failed", reason: "Start the sign-in first" };
    }
    // The window was stored but never enforced before 0.7.0 — a stale attempt used
    // to fail with the provider's own cryptic answer instead of a clear instruction.
    if (attemptExpired(attempt.expiresAt, this.deps.now())) {
      this.attempts.delete(provider);
      return { status: "failed", reason: "The sign-in window expired — start the sign-in again" };
    }
    if (!pasted) {
      return { status: "failed", reason: "Nothing pasted" };
    }
    try {
      const now = this.deps.now();
      const tokens =
        attempt.flow === "paste-code"
          ? await exchangeCode(pasted, attempt.pkce, this.deps.postJson, now)
          : await exchangeGeminiCode(
              extractGeminiCode(pasted, attempt.pkce.state),
              attempt.pkce,
              this.deps.postForm,
              now,
            );
      await this.finish(provider, tokens);
      return { status: "signed-in" };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.failures.set(provider, reason);
      return { status: "failed", reason };
    }
  }

  /**
   * The current sign-in state of one subscription, for the admin row.
   *
   * @param provider the subscription kind
   * @returns the state
   */
  public async state(provider: string): Promise<SignInState> {
    const failure = this.failures.get(provider);
    const attempt = this.attempts.get(provider);
    if (attempt?.flow === "device-code") {
      return {
        status: "awaiting-device",
        userCode: attempt.start.userCode,
        verificationUrl: CHATGPT_OAUTH.verificationUrl,
        expiresAt: attempt.start.expiresAt,
      };
    }
    if (attempt) {
      if (attemptExpired(attempt.expiresAt, this.deps.now())) {
        this.attempts.delete(provider);
        return { status: "failed", reason: "The sign-in window expired — start the sign-in again" };
      }
      return { status: "awaiting-paste", url: attempt.url, flow: attempt.flow };
    }
    // A valid sign-in WINS over a remembered failure: working tokens mean the
    // account is signed in, whatever an earlier attempt left behind — showing the
    // sign-in screen to a signed-in user was the bug (krobi 2026-09-01). The stale
    // failure is dropped so it cannot resurface later.
    //
    // "Valid" means the tokens are there AND the last query was not rejected: a
    // refresh token the provider has revoked still sits on disk, and reporting that
    // as "signed in" put a green check next to an amber "Sign-in rejected" badge.
    // File existence is not liveness.
    if ((await this.deps.store(provider).load()) && !this.rejected.has(provider)) {
      this.failures.delete(provider);
      return { status: "signed-in" };
    }
    if (this.rejected.has(provider)) {
      return { status: "failed", reason: failure ?? "The stored sign-in was rejected — sign in again" };
    }
    if (failure) {
      return { status: "failed", reason: failure };
    }
    return { status: "signed-out" };
  }

  /**
   * Forget the tokens of one subscription.
   *
   * @param provider the subscription kind
   * @returns the resulting state
   */
  public async signOut(provider: string): Promise<SignInState> {
    await this.deps.store(provider).clear();
    this.attempts.delete(provider);
    this.failures.delete(provider);
    this.rejected.delete(provider);
    this.stopPoller(provider);
    return { status: "signed-out" };
  }

  /**
   * Store fresh tokens and tell the adapter to query that account at once — waiting
   * up to a full interval after a successful sign-in reads as "it did not work".
   *
   * @param provider the subscription kind
   * @param tokens the token set
   */
  private async finish(provider: string, tokens: TokenSet): Promise<void> {
    await this.deps.store(provider).save(tokens);
    this.attempts.delete(provider);
    this.failures.delete(provider);
    this.rejected.delete(provider);
    this.stopPoller(provider);
    this.deps.log.info(`${PROVIDER_LABELS[provider] ?? provider}: signed in`);
    this.deps.onSignedIn(provider);
  }

  /**
   * Poll the device-code endpoint until the user confirmed, the window closed or
   * the adapter stops. The handle lives in memory only — a restart mid-flow just
   * means the user starts again, which is cheaper than persisting a 15-minute secret.
   *
   * @param provider the subscription kind
   * @param start the device-code handle
   */
  private armPoller(provider: string, start: DeviceCodeStart): void {
    const tick = async (): Promise<void> => {
      // One request at a time. The server advises five seconds and a request may
      // take fifteen, so ticks could otherwise pile up on a slow answer.
      if (this.polling.has(provider)) {
        return;
      }
      this.polling.add(provider);
      try {
        if (attemptExpired(start.expiresAt, this.deps.now())) {
          this.stopPoller(provider);
          this.attempts.delete(provider);
          this.failures.set(provider, "The code expired — start the sign-in again");
          return;
        }
        const result = await pollDeviceCode(start, this.deps.postJson);
        if (result.status === "ready") {
          this.stopPoller(provider);
          const tokens = await exchangeDeviceCode(
            result.code,
            result.codeVerifier,
            this.deps.postForm,
            this.deps.now(),
          );
          await this.finish(provider, tokens);
        }
      } catch (e) {
        this.stopPoller(provider);
        this.attempts.delete(provider);
        this.failures.set(provider, e instanceof Error ? e.message : String(e));
      } finally {
        this.polling.delete(provider);
      }
    };
    this.pollers.set(
      provider,
      this.deps.schedule(() => void tick(), Math.max(start.intervalSec, 1) * 1000),
    );
  }

  /**
   * Stop a running device-code poller.
   *
   * @param provider the subscription kind
   */
  private stopPoller(provider: string): void {
    const handle = this.pollers.get(provider);
    if (handle !== undefined) {
      this.deps.cancel(handle);
    }
    this.pollers.delete(provider);
  }
}

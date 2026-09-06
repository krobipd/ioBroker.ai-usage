import { PROVIDERS, type SignInFlow } from "./provider";

/**
 * Which sign-in flow a subscription uses — see {@link SignInFlow} for why they differ.
 * Derived from the provider catalogue, so a new subscription cannot be half-added.
 */
export const SIGN_IN_FLOWS: Record<string, SignInFlow> = Object.fromEntries(
  PROVIDERS.filter(entry => entry.flow !== undefined).map(entry => [entry.kind, entry.flow as SignInFlow]),
);

/** The live state of one subscription row, as the admin panel renders it. */
export type SignInState =
  /** Signed in, tokens usable. */
  | { status: "signed-in" }
  /** Nothing started yet. */
  | { status: "signed-out" }
  /** Claude/Gemini: the user has to open the link and paste something back. */
  | { status: "awaiting-paste"; url: string; flow: SignInFlow }
  /** ChatGPT: the user types this code on the provider's page; the adapter waits. */
  | { status: "awaiting-device"; userCode: string; verificationUrl: string; expiresAt: number }
  /** The last attempt failed — reason is user-facing. */
  | { status: "failed"; reason: string };

/** Readable name per provider — log lines must not show the internal kind. */
export const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  PROVIDERS.map(entry => [entry.kind, entry.label]),
);

/**
 * How long a started sign-in stays usable (ms).
 *
 * Claude's pasted code and Google's pasted address are good for a quarter of an
 * hour; ChatGPT's device code says so in its own prompt. One constant, so the
 * window cannot be fifteen minutes in one flow and something else in the next.
 */
export const SIGN_IN_WINDOW_MS = 15 * 60_000;

/**
 * Whether a running sign-in attempt is over.
 *
 * @param expiresAt end of the attempt window (ms since epoch)
 * @param now current time (ms)
 * @returns true when the attempt can no longer succeed
 */
export function attemptExpired(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}

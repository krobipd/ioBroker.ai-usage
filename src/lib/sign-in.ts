import type { SignInFlow } from "./provider";

/** Which sign-in flow a subscription uses — see {@link SignInFlow} for why they differ. */
export const SIGN_IN_FLOWS: Record<string, SignInFlow> = {
  "claude-sub": "paste-code",
  "chatgpt-sub": "device-code",
  "gemini-sub": "paste-url",
};

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

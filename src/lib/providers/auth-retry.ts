import { FetchError, type TokenSet, type TokenStore } from "../provider";

/**
 * Run a usage call and, if the provider rejects the access token, refresh ONCE and
 * repeat it.
 *
 * The three subscriptions refresh proactively — a minute before the stored expiry.
 * That covers the normal case and misses the one the user notices: a token the
 * provider invalidated on its side BEFORE it expired (a password change, a revoked
 * session, a rotated client). Until then every poll answered 401, the adapter
 * reported "sign-in rejected" with a notification, and it healed by itself once the
 * clock reached the expiry — up to eight hours later for Claude.
 *
 * Exactly one retry, and only for `auth`. A second rejection is the real answer:
 * the stored sign-in no longer works and the user has to act. A failing REFRESH is
 * not retried either — it throws `auth` of its own and means the same thing.
 *
 * The extra rotation this can cost is the reason it exists only alongside
 * {@link TokenStore.replace}: the rotated pair is taken over even when the disk
 * refuses it, and a sign-out that lands in between is not written back.
 *
 * @param tokens the tokens to try first
 * @param store where a rotated pair is persisted
 * @param refresh how this provider refreshes (its own token endpoint)
 * @param call the usage call, run with whichever tokens are current
 * @returns whatever the usage call returns
 */
export async function withAuthRetry<T>(
  tokens: TokenSet,
  store: TokenStore,
  refresh: (tokens: TokenSet) => Promise<TokenSet>,
  call: (tokens: TokenSet) => Promise<T>,
): Promise<T> {
  try {
    return await call(tokens);
  } catch (e) {
    if (!(e instanceof FetchError) || e.kind !== "auth") {
      throw e;
    }
    const next = await refresh(tokens);
    await store.replace(tokens, next);
    return await call(next);
  }
}

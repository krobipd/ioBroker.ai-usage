import type { UsageSnapshot } from "./provider";
import { round2 } from "./pure-helpers";
import { lockedWindows, maxLimitPercent } from "./snapshot-tree";

/** One account's contribution to the totals. */
export interface AccountStatus {
  /** The last successful snapshot, if any. */
  snapshot?: UsageSnapshot;
  /** When {@link snapshot} was fetched (ms) — money only counts in its own UTC day/month. */
  fetchedAt?: number;
  /** Whether the account is currently reachable. */
  reachable: boolean;
  /** Whether the account is above its warn threshold. */
  warning: boolean;
  /**
   * The account's `limitReached` as the previous process left it, while this process
   * has no snapshot of the account yet (decision 74). Same rule as `warning`: it
   * counts until a snapshot arrives or the account's alarms are retired.
   */
  limitReachedSeed?: boolean;
}

/** The adapter-wide totals. */
export interface Totals {
  /** Summed real money spent today (same-currency accounts only). */
  costsToday: number;
  /** Summed real money spent this month. */
  costsMonth: number;
  /** Summed projected month-end spend. */
  costsProjectedMonth: number;
  /**
   * The highest utilisation of any account (percent) — per account the fullest
   * plan-wide window or its granted budget, whichever is higher. Model-scoped
   * windows never count (decision 80).
   */
  maxLimitPercent: number;
  /** Number of accounts above their warn threshold. */
  warningsActive: number;
  /** True when any account reached 100 % — on its limit window or on its budget. */
  limitReached: boolean;
  /** Reachable accounts. */
  accountsReachable: number;
  /** Configured (enabled) accounts. */
  accounts: number;
}

/** The currency the totals are summed in. Non-matching and piece-counters stay out. */
const TOTAL_CURRENCY = "USD";

/**
 * Whether two instants fall in the same UTC day (or, with `monthOnly`, month).
 *
 * @param a first instant (ms)
 * @param b second instant (ms)
 * @param monthOnly compare the month only
 * @returns true when they share the period
 */
function samePeriod(a: number, b: number, monthOnly: boolean): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getUTCFullYear() === y.getUTCFullYear() &&
    x.getUTCMonth() === y.getUTCMonth() &&
    (monthOnly || x.getUTCDate() === y.getUTCDate())
  );
}

/**
 * Compute the adapter-wide totals from the in-memory account statuses. Money sums
 * include only real-money costs in {@link TOTAL_CURRENCY}; piece-counters and
 * foreign currencies are excluded by design.
 *
 * Money only counts in the period it was fetched for (decision 81). An account that
 * stopped delivering keeps its last snapshot — its own datapoints carry that, next
 * to their `lastUpdate` — but a sum named "today" or "this month" must not carry
 * yesterday's or last month's figure of it: an organisation account failing on the
 * 31st kept the whole previous month in `total.costs.month`.
 *
 * @param statuses each POLLED account's status
 * @param configured how many accounts the user switched on — including the ones the
 *   adapter cannot poll (missing credential). The user counts what they configured,
 *   so a number smaller than their own list would just look broken.
 * @param nowMs current time (ms) — decides which fetched money still counts
 * @returns the totals
 */
export function computeTotals(statuses: readonly AccountStatus[], configured: number, nowMs: number): Totals {
  let costsToday = 0;
  let costsMonth = 0;
  let costsProjectedMonth = 0;
  let maxPercent = 0;
  let warningsActive = 0;
  let limitReached = false;
  let reachable = 0;
  for (const status of statuses) {
    if (status.reachable) {
      reachable++;
    }
    if (status.warning) {
      warningsActive++;
    }
    const snapshot = status.snapshot;
    if (!snapshot) {
      if (status.limitReachedSeed) {
        limitReached = true;
      }
      continue;
    }
    const costs = snapshot.costs;
    if (costs && costs.currency === TOTAL_CURRENCY) {
      const fetchedAt = status.fetchedAt ?? nowMs;
      if (samePeriod(fetchedAt, nowMs, false)) {
        costsToday += costs.today ?? 0;
      }
      if (samePeriod(fetchedAt, nowMs, true)) {
        costsMonth += costs.month ?? 0;
        costsProjectedMonth += costs.projectedMonth ?? costs.month ?? 0;
      }
    }
    const percent = maxLimitPercent(snapshot);
    if (percent !== undefined) {
      maxPercent = Math.max(maxPercent, percent);
      if (percent >= 100) {
        limitReached = true;
      }
    }
    // A window the provider CLOSED counts here exactly as it does per account
    // (decision 36 — `locked_reason` is the honest signal, the percentage only
    // implies it). Reading the percentage alone, the sum said "no limit reached"
    // while the account's own `limitReached` said true at 42 % — two datapoints of
    // one adapter contradicting each other about the same fact.
    if (lockedWindows(snapshot).length > 0) {
      limitReached = true;
    }
  }
  return {
    costsToday: round2(costsToday),
    costsMonth: round2(costsMonth),
    costsProjectedMonth: round2(costsProjectedMonth),
    maxLimitPercent: round2(maxPercent),
    warningsActive,
    limitReached,
    accountsReachable: reachable,
    accounts: configured,
  };
}

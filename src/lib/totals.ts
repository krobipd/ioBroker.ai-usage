import type { UsageSnapshot } from "./provider";
import { maxLimitPercent } from "./snapshot-tree";

/** One account's contribution to the totals. */
export interface AccountStatus {
  /** The last successful snapshot, if any. */
  snapshot?: UsageSnapshot;
  /** Whether the account is currently reachable. */
  reachable: boolean;
  /** Whether the account is above its warn threshold. */
  warning: boolean;
}

/** The adapter-wide totals. */
export interface Totals {
  /** Summed real money spent today (same-currency accounts only). */
  costsToday: number;
  /** Summed real money spent this month. */
  costsMonth: number;
  /** Summed projected month-end spend. */
  costsProjectedMonth: number;
  /** The currency the sums are in. */
  currency: string;
  /** The highest PLAN-WIDE limit utilisation of any account (percent); model-scoped windows stay out. */
  maxLimitPercent: number;
  /** Number of accounts above their warn threshold. */
  warningsActive: number;
  /** True when any plan-wide limit window is full (>= 100 %). */
  limitReached: boolean;
  /** Reachable accounts. */
  accountsReachable: number;
  /** Configured (enabled) accounts. */
  accounts: number;
}

/** The currency the totals are summed in. Non-matching and piece-counters stay out. */
const TOTAL_CURRENCY = "USD";

/**
 * Compute the adapter-wide totals from the in-memory account statuses. Money sums
 * include only real-money costs in {@link TOTAL_CURRENCY}; piece-counters and
 * foreign currencies are excluded by design.
 *
 * @param statuses each account's status
 * @returns the totals
 */
export function computeTotals(statuses: readonly AccountStatus[]): Totals {
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
      continue;
    }
    const costs = snapshot.costs;
    if (costs && costs.currency === TOTAL_CURRENCY) {
      costsToday += costs.today ?? 0;
      costsMonth += costs.month ?? 0;
      costsProjectedMonth += costs.projectedMonth ?? costs.month ?? 0;
    }
    const percent = maxLimitPercent(snapshot);
    if (percent !== undefined) {
      maxPercent = Math.max(maxPercent, percent);
      if (percent >= 100) {
        limitReached = true;
      }
    }
  }
  return {
    costsToday: round2(costsToday),
    costsMonth: round2(costsMonth),
    costsProjectedMonth: round2(costsProjectedMonth),
    currency: TOTAL_CURRENCY,
    maxLimitPercent: round2(maxPercent),
    warningsActive,
    limitReached,
    accountsReachable: reachable,
    accounts: statuses.length,
  };
}

/**
 * Round to two decimals (money/percent display).
 *
 * @param value the value
 * @returns the rounded value
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

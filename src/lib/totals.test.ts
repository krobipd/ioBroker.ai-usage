import { computeTotals } from "./totals";

describe("computeTotals", () => {
  test("sums USD costs, tracks max percent, counts warnings and reachability", () => {
    const totals = computeTotals(
      [
        {
          reachable: true,
          warning: true,
          snapshot: {
            limits: [{ name: "week", label: "Week", percent: 82 }],
            costs: { month: 3.2, currency: "USD" },
          },
        },
        {
          reachable: true,
          warning: false,
          snapshot: { costs: { today: 0.8, month: 14.6, projectedMonth: 22, currency: "USD" } },
        },
        { reachable: false, warning: false },
      ],
      3,
    );
    expect(totals.costsToday).toBe(0.8);
    expect(totals.costsMonth).toBe(17.8);
    // Without its own projection, an account contributes its month spend.
    expect(totals.costsProjectedMonth).toBe(25.2);
    expect(totals.maxLimitPercent).toBe(82);
    expect(totals.warningsActive).toBe(1);
    expect(totals.limitReached).toBe(false);
    expect(totals.accountsReachable).toBe(2);
    expect(totals.accounts).toBe(3);
  });

  test("a full window flips limitReached", () => {
    const totals = computeTotals(
      [{ reachable: true, warning: true, snapshot: { limits: [{ name: "s", label: "S", percent: 100 }] } }],
      1,
    );
    expect(totals.limitReached).toBe(true);
  });

  test("foreign currencies and piece-credits stay out of the money sums", () => {
    const totals = computeTotals(
      [
        { reachable: true, warning: false, snapshot: { costs: { month: 99, currency: "CNY" } } },
        {
          reachable: true,
          warning: false,
          snapshot: { credits: { used: 165, limit: 300, percent: 55, currency: "requests", pieces: true } },
        },
      ],
      2,
    );
    expect(totals.costsMonth).toBe(0);
    // The piece-credit percent still counts as a limit utilisation.
    expect(totals.maxLimitPercent).toBe(55);
  });

  test("accounts counts what the user configured, not what could be polled", () => {
    // Two accounts switched on, one of them without a usable credential: the user
    // reads their own list, so a smaller number would just look broken.
    const totals = computeTotals([{ reachable: true, warning: false }], 2);
    expect(totals.accounts).toBe(2);
    expect(totals.accountsReachable).toBe(1);
  });

  test("an empty account list yields zeroed totals", () => {
    const totals = computeTotals([], 0);
    expect(totals).toMatchObject({
      costsToday: 0,
      costsMonth: 0,
      maxLimitPercent: 0,
      warningsActive: 0,
      limitReached: false,
      accountsReachable: 0,
      accounts: 0,
    });
  });
});

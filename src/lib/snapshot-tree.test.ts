import type { UsageSnapshot } from "./provider";
import { limitingWindow, mapSnapshot, maxLimitPercent, orphanObjectIds } from "./snapshot-tree";

describe("mapSnapshot", () => {
  test("a subscription snapshot yields device, limit channels and percent/reset states", () => {
    const snapshot: UsageSnapshot = {
      limits: [
        { name: "session", label: "5-hour session", percent: 34, resetAt: "2026-08-25T14:00:00Z" },
        { name: "week", label: "Week", percent: 62 },
        { name: "fable-4x", label: "Fable weekly", percent: 71 },
      ],
    };
    const { objects, writes } = mapSnapshot("claude", snapshot);
    // The account's own device object belongs to the engine's skeleton, which is the
    // only place that carries the link drawing the connection icon.
    expect(objects.some(o => o.id === "claude")).toBe(false);
    const ids = objects.map(o => o.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "claude.limits",
        "claude.limits.session",
        "claude.limits.session.percent",
        "claude.limits.session.resetAt",
        "claude.limits.week.percent",
        "claude.limits.fable-4x.percent",
      ]),
    );
    // The reset state is a FIXED part of every window: it exists even while the
    // provider reports no running window, and its value is then the empty string.
    // Deleting it on a momentary omission made the datapoint come and go with the
    // provider's mood (krobi, live 2026-09-01).
    expect(ids).toContain("claude.limits.week.resetAt");
    expect(writes).toContainEqual({ id: "claude.limits.week.resetAt", value: "" });
    expect(writes).toContainEqual({ id: "claude.limits.session.resetAt", value: "2026-08-25T14:00:00Z" });
    expect(writes).toContainEqual({ id: "claude.limits.session.percent", value: 34 });
    // Everything is read-only.
    for (const object of objects.filter(o => o.type === "state")) {
      expect(object.common.write).toBe(false);
    }
  });

  test("credits and costs land in their folders with the currency as unit", () => {
    const { objects, writes } = mapSnapshot("router", {
      credits: { used: 41.2, limit: 100, remaining: 58.8, percent: 41.2, currency: "USD" },
      costs: { total: 41.2, currency: "USD" },
    });
    const percent = objects.find(o => o.id === "router.credits.percent");
    expect(percent?.common.unit).toBe("%");
    const used = objects.find(o => o.id === "router.credits.used");
    expect(used?.common.unit).toBe("USD");
    expect(writes).toContainEqual({ id: "router.costs.total", value: 41.2 });
  });

  test("piece-credits carry no currency unit", () => {
    const { objects } = mapSnapshot("pieces", {
      credits: { used: 165, limit: 300, remaining: 135, percent: 55, currency: "requests", pieces: true },
    });
    expect(objects.find(o => o.id === "pieces.credits.used")?.common.unit).toBe("");
  });

  test("tokens with per-model breakdown create the models channel", () => {
    const { objects, writes } = mapSnapshot("oai", {
      costs: { today: 0.8, month: 14.6, projectedMonth: 22, currency: "USD" },
      tokens: {
        inputToday: 210000,
        outputToday: 48000,
        perModel: [{ model: "gpt-5-mini", tokens: 150000, cost: 0.5 }],
      },
    });
    const ids = objects.map(o => o.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "oai.tokens.inputToday",
        "oai.models",
        "oai.models.gpt-5-mini",
        "oai.models.gpt-5-mini.tokensToday",
        "oai.models.gpt-5-mini.costToday",
      ]),
    );
    expect(writes).toContainEqual({ id: "oai.costs.projectedMonth", value: 22 });
  });

  test("an empty snapshot yields nothing at all", () => {
    const { objects, writes } = mapSnapshot("empty", {});
    expect(objects).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  test("reset vouchers land under credits, with an always-present expiry companion", () => {
    const withVoucher = mapSnapshot("gpt", {
      credits: { remaining: 4, currency: "USD", resetCredits: 2, resetCreditsNextExpiry: "2026-10-01T00:00:00Z" },
    });
    expect(withVoucher.writes).toContainEqual({ id: "gpt.credits.resetCredits", value: 2 });
    expect(withVoucher.writes).toContainEqual({
      id: "gpt.credits.resetCreditsNextExpiry",
      value: "2026-10-01T00:00:00Z",
    });
    // No voucher held: the count says 0 and the companion empties — neither leaves.
    const without = mapSnapshot("gpt", { credits: { remaining: 4, currency: "USD", resetCredits: 0 } });
    expect(without.writes).toContainEqual({ id: "gpt.credits.resetCredits", value: 0 });
    expect(without.writes).toContainEqual({ id: "gpt.credits.resetCreditsNextExpiry", value: "" });
  });

  test("the DeepSeek availability flag becomes a read-only indicator", () => {
    const { objects } = mapSnapshot("ds", {
      credits: { remaining: 12.5, currency: "USD" },
      available: true,
    });
    const available = objects.find(o => o.id === "ds.available");
    expect(available?.common).toMatchObject({ type: "boolean", role: "indicator", write: false });
  });
});

describe("orphanObjectIds", () => {
  test("a value inside a still-delivered window is never an orphan", () => {
    // The krobi case, live 2026-09-01: Anthropic omitted resets_at mid-throttle,
    // the datapoint was deleted with "the provider no longer reports it" and came
    // back after the reset. The window still delivered its percent — nothing goes.
    const known = ["claude.limits.week.percent", "claude.limits.week.resetAt"];
    const current = ["claude.limits.week.percent"];
    expect(orphanObjectIds(known, current, [])).toEqual([]);
  });

  test("a whole window that fell out of the answer goes, channel after states", () => {
    const known = ["claude.limits.week.percent", "claude.limits.week.resetAt", "claude.limits.session.percent"];
    const current = ["claude.limits.session.percent"];
    const gone = orphanObjectIds(known, current, []);
    expect(gone).toContain("claude.limits.week.percent");
    expect(gone).toContain("claude.limits.week.resetAt");
    expect(gone).toContain("claude.limits.week");
    expect(gone.indexOf("claude.limits.week")).toBeGreaterThan(gone.indexOf("claude.limits.week.resetAt"));
    expect(gone).not.toContain("claude.limits");
    expect(gone).not.toContain("claude.limits.session.percent");
  });

  test("a renamed model takes its subtree along, the surviving one stays", () => {
    const known = ["oai.models.gpt-5.tokensToday", "oai.models.gpt-5-mini.tokensToday"];
    const current = ["oai.models.gpt-5-mini.tokensToday"];
    const gone = orphanObjectIds(known, current, []);
    expect(gone).toContain("oai.models.gpt-5.tokensToday");
    expect(gone).toContain("oai.models.gpt-5");
    expect(gone).not.toContain("oai.models");
  });

  test("credits/costs/tokens values stay once created, whatever the round delivers", () => {
    const known = ["ds.credits.granted", "ds.credits.toppedUp", "ds.available", "ds.costs.month"];
    const current = ["ds.credits.remaining"];
    expect(orphanObjectIds(known, current, [])).toEqual([]);
  });

  test("skeleton ids are always kept", () => {
    const known = ["claude.info.unreach", "claude.limits.week.percent"];
    expect(orphanObjectIds(known, ["claude.limits.week.percent"], ["claude.info.unreach"])).toEqual([]);
  });
});

describe("maxLimitPercent", () => {
  test("takes the highest window, includes the credits percent, undefined without any", () => {
    expect(
      maxLimitPercent({
        limits: [
          { name: "a", label: "A", percent: 30 },
          { name: "b", label: "B", percent: 80 },
        ],
      }),
    ).toBe(80);
    expect(maxLimitPercent({ credits: { percent: 55, currency: "USD" } })).toBe(55);
    expect(maxLimitPercent({})).toBeUndefined();
  });

  test("a model-scoped window never speaks for the account, however full it is", () => {
    const snapshot = {
      limits: [
        { name: "session", label: "Session (5 h)", percent: 72 },
        { name: "week", label: "Week (all models)", percent: 72 },
        { name: "weekly_scoped-Fable", label: "weekly scoped Fable", percent: 100, scoped: true },
      ],
    };
    expect(maxLimitPercent(snapshot)).toBe(72);
    expect(limitingWindow(snapshot)).toEqual({ percent: 72, label: "Session (5 h)" });
  });

  test("a model window stays out as long as a plan-wide one exists", () => {
    expect(
      maxLimitPercent({
        limits: [
          { name: "week", label: "Week", percent: 40 },
          { name: "fable", label: "Fable weekly", percent: 100, scoped: true },
        ],
      }),
    ).toBe(40);
  });

  test("an account with ONLY model windows is spoken for by the fullest of them", () => {
    // Google reports no plan-wide bucket at all — leaving the account without any
    // window would mean its warning could never fire.
    expect(
      limitingWindow({
        limits: [
          { name: "pro", label: "gemini-2.5-pro", percent: 25, scoped: true },
          { name: "flash", label: "gemini-2.5-flash", percent: 80, scoped: true },
        ],
      }),
    ).toEqual({ percent: 80, label: "gemini-2.5-flash" });
  });

  test("the label of the deciding window comes back for the warning message", () => {
    expect(
      limitingWindow({
        limits: [
          { name: "session", label: "Session (5 h)", percent: 40 },
          { name: "week", label: "Week (all models)", percent: 91 },
        ],
      }),
    ).toEqual({ percent: 91, label: "Week (all models)" });
  });
});

import type { UsageSnapshot } from "./provider";
import { limitingWindow, mapSnapshot, maxLimitPercent } from "./snapshot-tree";

describe("mapSnapshot", () => {
  test("a subscription snapshot yields device, limit channels and percent/reset states", () => {
    const snapshot: UsageSnapshot = {
      limits: [
        { name: "session", label: "5-hour session", percent: 34, resetAt: "2026-08-25T14:00:00Z" },
        { name: "week", label: "Week", percent: 62 },
        { name: "fable-4x", label: "Fable weekly", percent: 71 },
      ],
    };
    const { objects, writes } = mapSnapshot("claude", "Claude Max", "claude-sub", snapshot);
    expect(objects[0]).toMatchObject({ id: "claude", type: "device" });
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
    // No reset state for a window without a reset time.
    expect(ids).not.toContain("claude.limits.week.resetAt");
    expect(writes).toContainEqual({ id: "claude.limits.session.percent", value: 34 });
    // Everything is read-only.
    for (const object of objects.filter(o => o.type === "state")) {
      expect(object.common.write).toBe(false);
    }
  });

  test("credits and costs land in their folders with the currency as unit", () => {
    const { objects, writes } = mapSnapshot("router", "Router", "openrouter", {
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
    const { objects } = mapSnapshot("pieces", "Pieces", "deepseek", {
      credits: { used: 165, limit: 300, remaining: 135, percent: 55, currency: "requests", pieces: true },
    });
    expect(objects.find(o => o.id === "pieces.credits.used")?.common.unit).toBe("");
  });

  test("tokens with per-model breakdown create the models channel", () => {
    const { objects, writes } = mapSnapshot("oai", "OpenAI", "openai", {
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

  test("an empty snapshot yields only the device node", () => {
    const { objects, writes } = mapSnapshot("empty", "Empty", "deepseek", {});
    expect(objects).toHaveLength(1);
    expect(writes).toHaveLength(0);
  });

  test("the DeepSeek availability flag becomes a read-only indicator", () => {
    const { objects } = mapSnapshot("ds", "DeepSeek", "deepseek", {
      credits: { remaining: 12.5, currency: "USD" },
      available: true,
    });
    const available = objects.find(o => o.id === "ds.available");
    expect(available?.common).toMatchObject({ type: "boolean", role: "indicator", write: false });
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

  test("an account whose windows are ALL scoped reports none rather than the wrong one", () => {
    expect(maxLimitPercent({ limits: [{ name: "m", label: "M", percent: 100, scoped: true }] })).toBeUndefined();
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

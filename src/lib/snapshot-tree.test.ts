import type { UsageSnapshot } from "./provider";
import {
  limitingWindow,
  lockedWindows,
  mapSnapshot,
  maxLimitPercent,
  orphanObjectIds,
  windowEnd,
} from "./snapshot-tree";

describe("mapSnapshot", () => {
  test("a subscription snapshot yields device, limit channels and percent/reset states", () => {
    const snapshot: UsageSnapshot = {
      limits: [
        {
          name: "session",
          labelKey: "nameWindowSession",
          label: "5-hour session",
          percent: 34,
          resetAt: "2026-08-25T14:00:00Z",
        },
        { name: "week", label: "Week", labelKey: "nameWindowSession", percent: 62 },
        { name: "fable-4x", label: "Fable weekly", labelKey: "nameWindowSession", percent: 71 },
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
        perModel: [{ model: "gpt-5-mini", tokens: 150000 }],
      },
    });
    const ids = objects.map(o => o.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "oai.tokens.inputToday",
        "oai.models",
        "oai.models.gpt-5-mini",
        "oai.models.gpt-5-mini.tokensToday",
      ]),
    );
    // The per-model cost datapoint is gone with the field that never had a
    // producer — the OpenAI cost report groups by line item, not by model.
    expect(ids).not.toContain("oai.models.gpt-5-mini.costToday");
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
    // Under `credits`, not at the account root: it is a statement about the
    // balance, and at the root it read as a third account-wide alarm next to
    // `warning` and `limitReached`.
    expect(objects.find(o => o.id === "ds.available")).toBeUndefined();
    const available = objects.find(o => o.id === "ds.credits.available");
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

  test("a round that says NOTHING about a branch never sweeps it", () => {
    // An answer that carries no limit window at all has not reported that the
    // windows are gone — it has reported nothing. Sweeping on that wiped the whole
    // limit tree on a single unreadable answer (fleet rule: an empty API list is
    // not a cleanup trigger).
    const known = ["claude.limits.week.percent", "claude.limits.session.percent"];
    expect(orphanObjectIds(known, [], [])).toEqual([]);
  });

  test("a report with no bucket for today keeps the model channels", () => {
    // Measured: after UTC midnight the usage report has no bucket yet, the models
    // branch fell silent and the whole subtree was deleted — every night.
    const known = ["oai.models.gpt-5.tokensToday", "oai.costs.today"];
    expect(orphanObjectIds(known, ["oai.costs.today"], [])).toEqual([]);
  });

  test("silence in ONE branch does not protect the other", () => {
    // limits speaks, models does not: the vanished window still goes, the models
    // subtree stays. The exemption is per branch, not a blanket amnesty.
    const known = ["c.limits.week.percent", "c.limits.session.percent", "c.models.opus.tokensToday"];
    const gone = orphanObjectIds(known, ["c.limits.session.percent"], []);
    expect(gone).toContain("c.limits.week.percent");
    expect(gone).not.toContain("c.models.opus.tokensToday");
  });
});

describe("maxLimitPercent", () => {
  test("takes the highest window, includes the credits percent, undefined without any", () => {
    expect(
      maxLimitPercent({
        limits: [
          { name: "a", label: "A", labelKey: "nameWindowSession", percent: 30 },
          { name: "b", label: "B", labelKey: "nameWindowSession", percent: 80 },
        ],
      }),
    ).toBe(80);
    expect(maxLimitPercent({ credits: { percent: 55, currency: "USD" } })).toBe(55);
    expect(maxLimitPercent({})).toBeUndefined();
  });

  test("a model-scoped window never speaks for the account, however full it is", () => {
    const snapshot = {
      limits: [
        { name: "session", label: "Session (5 h)", labelKey: "nameWindowSession", percent: 72 },
        { name: "week", label: "Week (all models)", labelKey: "nameWindowSession", percent: 72 },
        {
          name: "weekly_scoped-Fable",
          label: "weekly scoped Fable",
          labelKey: "nameWindowSession",
          percent: 100,
          scoped: true,
        },
      ],
    };
    expect(maxLimitPercent(snapshot)).toBe(72);
    expect(limitingWindow(snapshot)).toMatchObject({ percent: 72, label: "Session (5 h)" });
  });

  test("a model window stays out as long as a plan-wide one exists", () => {
    expect(
      maxLimitPercent({
        limits: [
          { name: "week", label: "Week", labelKey: "nameWindowSession", percent: 40 },
          { name: "fable", label: "Fable weekly", labelKey: "nameWindowSession", percent: 100, scoped: true },
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
          { name: "pro", label: "gemini-2.5-pro", labelKey: "nameWindowSession", percent: 25, scoped: true },
          { name: "flash", label: "gemini-2.5-flash", labelKey: "nameWindowSession", percent: 80, scoped: true },
        ],
      }),
    ).toMatchObject({ percent: 80, label: "gemini-2.5-flash" });
  });

  test("the label of the deciding window comes back for the warning message", () => {
    expect(
      limitingWindow({
        limits: [
          { name: "session", label: "Session (5 h)", labelKey: "nameWindowSession", percent: 40 },
          { name: "week", label: "Week (all models)", labelKey: "nameWindowSession", percent: 91 },
        ],
      }),
    ).toMatchObject({ percent: 91, label: "Week (all models)" });
  });
});

describe("which window is in force", () => {
  test("the provider's own mark wins where there is one", () => {
    // Claude states it per window: with Fable at 97 % the model window is active
    // while session at 8 % and week at 54 % are not (measured 2026-09-06).
    const { writes } = mapSnapshot("claude", {
      limits: [
        { name: "session", label: "Session", labelKey: "nameWindowSession", percent: 8, active: false },
        { name: "week", label: "Week", labelKey: "nameWindowWeek", percent: 54, active: false },
        {
          name: "weekly_scoped-Fable",
          label: "weekly scoped Fable",
          labelKey: "nameWindowModelWeek",
          percent: 97,
          scoped: true,
          active: true,
        },
      ],
    });
    expect(writes).toContainEqual({ id: "claude.limits.session.active", value: false, indicator: true });
    expect(writes).toContainEqual({ id: "claude.limits.week.active", value: false, indicator: true });
    expect(writes).toContainEqual({ id: "claude.limits.weekly_scoped-Fable.active", value: true, indicator: true });
  });

  test("without a mark the window that speaks for the account is the one in force", () => {
    // ChatGPT and Google send no such flag — the datapoint has to mean the same
    // thing there, so it falls back to the window the warning uses.
    const { writes } = mapSnapshot("chatgpt", {
      limits: [
        { name: "session", label: "Session", labelKey: "nameWindowSession", percent: 12 },
        { name: "week", label: "Week", labelKey: "nameWindowWeekShort", percent: 61 },
      ],
    });
    expect(writes).toContainEqual({ id: "chatgpt.limits.session.active", value: false, indicator: true });
    expect(writes).toContainEqual({ id: "chatgpt.limits.week.active", value: true, indicator: true });
  });

  test("a model window is never in force while a plan-wide one exists", () => {
    const { writes } = mapSnapshot("gemini", {
      limits: [
        { name: "week", label: "Week", labelKey: "nameWindowWeek", percent: 30 },
        { name: "pro", label: "pro", labelKey: "nameWindowQuota", percent: 100, scoped: true },
      ],
    });
    expect(writes).toContainEqual({ id: "gemini.limits.pro.active", value: false, indicator: true });
    expect(writes).toContainEqual({ id: "gemini.limits.week.active", value: true, indicator: true });
  });

  test("the flag is a read-only indicator", () => {
    const { objects } = mapSnapshot("a", {
      limits: [{ name: "w", label: "W", labelKey: "nameWindowSession", percent: 1 }],
    });
    expect(objects.find(o => o.id === "a.limits.w.active")?.common).toMatchObject({
      type: "boolean",
      role: "indicator",
      write: false,
    });
  });
});

describe("windowEnd", () => {
  test("rounds to the minute, which is what stops the history flooding", () => {
    // Anthropic recomputes the timestamp per request: the same window end arrives
    // as ...59.898Z, ...00.364Z, ...59.539Z. Unrounded, every poll counted as a
    // change — 952 history entries in five days for seventeen real windows.
    expect(windowEnd("2026-09-06T14:09:59.898660+00:00")).toBe("2026-09-06T14:10:00Z");
    expect(windowEnd("2026-09-06T14:10:00.364729+00:00")).toBe("2026-09-06T14:10:00Z");
    expect(windowEnd("2026-09-06T14:09:59.539015+00:00")).toBe("2026-09-06T14:10:00Z");
  });

  test("no window, no date — and nothing invented from rubbish", () => {
    expect(windowEnd(undefined)).toBe("");
    expect(windowEnd("")).toBe("");
    expect(windowEnd("whenever")).toBe("");
  });

  test("the window's reset datapoint carries the rounded value", () => {
    const { writes } = mapSnapshot("a", {
      limits: [
        {
          name: "w",
          label: "W",
          labelKey: "nameWindowSession",
          percent: 1,
          resetAt: "2026-09-06T14:09:59.898660+00:00",
        },
      ],
    });
    expect(writes).toContainEqual({ id: "a.limits.w.resetAt", value: "2026-09-06T14:10:00Z" });
  });
});

describe("lockedWindows", () => {
  test("a plan-wide window the provider closed is reported with its reason", () => {
    expect(
      lockedWindows({
        limits: [
          {
            name: "week",
            label: "Week (all models)",
            labelKey: "nameWindowWeek",
            percent: 100,
            lockedReason: "usage_limit_reached",
          },
        ],
      }),
    ).toEqual([{ label: "Week (all models)", reason: "usage_limit_reached" }]);
  });

  test("a locked MODEL window is not the account's problem", () => {
    // Same rule as the warning: Fable at its cap is the Fable limit, not the
    // account limit (krobi 2026-09-06).
    expect(
      lockedWindows({
        limits: [
          {
            name: "fable",
            label: "Fable",
            labelKey: "nameWindowModelWeek",
            percent: 100,
            scoped: true,
            lockedReason: "usage_limit_reached",
          },
        ],
      }),
    ).toEqual([]);
  });

  test("nothing locked, nothing reported", () => {
    expect(lockedWindows({ limits: [{ name: "w", label: "W", labelKey: "nameWindowWeek", percent: 99 }] })).toEqual([]);
  });
});

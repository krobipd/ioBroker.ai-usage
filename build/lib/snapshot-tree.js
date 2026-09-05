"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var snapshot_tree_exports = {};
__export(snapshot_tree_exports, {
  limitingWindow: () => limitingWindow,
  mapSnapshot: () => mapSnapshot,
  maxLimitPercent: () => maxLimitPercent,
  orphanObjectIds: () => orphanObjectIds
});
module.exports = __toCommonJS(snapshot_tree_exports);
var import_i18n = require("./i18n");
var import_pure_helpers = require("./pure-helpers");
function state(id, name, type, role, value, unit) {
  const common = { name, type, role, read: true, write: false };
  if (unit !== void 0) {
    common.unit = unit;
  }
  return { def: { id, type: "state", common }, write: { id, value } };
}
function mapSnapshot(accountId, snapshot) {
  var _a, _b, _c, _d;
  const objects = [];
  const writes = [];
  const add = (pair) => {
    objects.push(pair.def);
    writes.push(pair.write);
  };
  const channel = (id, name) => {
    objects.push({ id, type: "channel", common: { name } });
  };
  if (snapshot.limits && snapshot.limits.length > 0) {
    channel(`${accountId}.limits`, (0, import_i18n.tName)("nameLimits"));
    for (const limit of snapshot.limits) {
      const windowId = (0, import_pure_helpers.sanitizeId)(limit.name);
      if (!windowId) {
        continue;
      }
      const windowName = (0, import_i18n.tName)(limit.labelKey, limit.labelArg);
      channel(`${accountId}.limits.${windowId}`, windowName);
      add(
        state(
          `${accountId}.limits.${windowId}.percent`,
          (0, import_i18n.tName)("nameWindowPercent", windowName),
          "number",
          "value",
          limit.percent,
          "%"
        )
      );
      add(
        state(
          `${accountId}.limits.${windowId}.resetAt`,
          (0, import_i18n.tName)("nameWindowResetAt", windowName),
          "string",
          "date",
          (_a = limit.resetAt) != null ? _a : ""
        )
      );
    }
  }
  const credits = snapshot.credits;
  if (credits) {
    channel(`${accountId}.credits`, (0, import_i18n.tName)("nameCredits"));
    const unit = credits.pieces ? "" : credits.currency;
    if (credits.used !== void 0) {
      add(state(`${accountId}.credits.used`, (0, import_i18n.tName)("nameCreditsUsed"), "number", "value", credits.used, unit));
    }
    if (credits.limit !== void 0) {
      add(state(`${accountId}.credits.limit`, (0, import_i18n.tName)("nameCreditsLimit"), "number", "value", credits.limit, unit));
    }
    if (credits.remaining !== void 0) {
      add(
        state(
          `${accountId}.credits.remaining`,
          (0, import_i18n.tName)("nameCreditsRemaining"),
          "number",
          "value",
          credits.remaining,
          unit
        )
      );
    }
    if (credits.percent !== void 0) {
      add(state(`${accountId}.credits.percent`, (0, import_i18n.tName)("nameCreditsPercent"), "number", "value", credits.percent, "%"));
    }
    if (credits.granted !== void 0) {
      add(state(`${accountId}.credits.granted`, (0, import_i18n.tName)("nameCreditsGranted"), "number", "value", credits.granted, unit));
    }
    if (credits.toppedUp !== void 0) {
      add(
        state(`${accountId}.credits.toppedUp`, (0, import_i18n.tName)("nameCreditsToppedUp"), "number", "value", credits.toppedUp, unit)
      );
    }
    if (credits.resetCredits !== void 0) {
      add(
        state(`${accountId}.credits.resetCredits`, (0, import_i18n.tName)("nameResetCredits"), "number", "value", credits.resetCredits)
      );
      add(
        state(
          `${accountId}.credits.resetCreditsNextExpiry`,
          (0, import_i18n.tName)("nameResetCreditsExpiry"),
          "string",
          "date",
          (_b = credits.resetCreditsNextExpiry) != null ? _b : ""
        )
      );
    }
  }
  const costs = snapshot.costs;
  if (costs) {
    channel(`${accountId}.costs`, (0, import_i18n.tName)("nameCosts"));
    if (costs.today !== void 0) {
      add(state(`${accountId}.costs.today`, (0, import_i18n.tName)("nameCostsToday"), "number", "value", costs.today, costs.currency));
    }
    if (costs.month !== void 0) {
      add(state(`${accountId}.costs.month`, (0, import_i18n.tName)("nameCostsMonth"), "number", "value", costs.month, costs.currency));
    }
    if (costs.total !== void 0) {
      add(state(`${accountId}.costs.total`, (0, import_i18n.tName)("nameCostsTotal"), "number", "value", costs.total, costs.currency));
    }
    if (costs.projectedMonth !== void 0) {
      add(
        state(
          `${accountId}.costs.projectedMonth`,
          (0, import_i18n.tName)("nameCostsProjected"),
          "number",
          "value",
          costs.projectedMonth,
          costs.currency
        )
      );
    }
  }
  const tokens = snapshot.tokens;
  if (tokens) {
    channel(`${accountId}.tokens`, (0, import_i18n.tName)("nameTokens"));
    if (tokens.inputToday !== void 0) {
      add(state(`${accountId}.tokens.inputToday`, (0, import_i18n.tName)("nameTokensInput"), "number", "value", tokens.inputToday));
    }
    if (tokens.outputToday !== void 0) {
      add(state(`${accountId}.tokens.outputToday`, (0, import_i18n.tName)("nameTokensOutput"), "number", "value", tokens.outputToday));
    }
    if (tokens.perModel && tokens.perModel.length > 0) {
      channel(`${accountId}.models`, (0, import_i18n.tName)("nameModels"));
      for (const model of tokens.perModel) {
        const modelId = (0, import_pure_helpers.sanitizeId)(model.model);
        if (!modelId) {
          continue;
        }
        channel(`${accountId}.models.${modelId}`, model.model);
        if (model.tokens !== void 0) {
          add(
            state(
              `${accountId}.models.${modelId}.tokensToday`,
              (0, import_i18n.tName)("nameModelTokens", model.model),
              "number",
              "value",
              model.tokens
            )
          );
        }
        if (model.cost !== void 0) {
          add(
            state(
              `${accountId}.models.${modelId}.costToday`,
              (0, import_i18n.tName)("nameModelCosts", model.model),
              "number",
              "value",
              model.cost,
              (_d = (_c = snapshot.costs) == null ? void 0 : _c.currency) != null ? _d : "USD"
            )
          );
        }
      }
    }
  }
  if (snapshot.available !== void 0) {
    add(state(`${accountId}.available`, (0, import_i18n.tName)("nameAvailable"), "boolean", "indicator", snapshot.available));
  }
  return { objects, writes };
}
function limitingWindow(snapshot) {
  var _a, _b;
  const limits = (_a = snapshot.limits) != null ? _a : [];
  const planWide = limits.filter((limit) => !limit.scoped);
  let best;
  for (const limit of planWide.length > 0 ? planWide : limits) {
    if (!best || limit.percent > best.percent) {
      best = { percent: limit.percent, label: limit.label };
    }
  }
  const credits = (_b = snapshot.credits) == null ? void 0 : _b.percent;
  if (credits !== void 0 && (!best || credits > best.percent)) {
    best = { percent: credits, label: "Credits" };
  }
  return best;
}
function orphanObjectIds(known, current, keep) {
  const surviving = /* @__PURE__ */ new Set([...current, ...keep]);
  const livingSubtrees = /* @__PURE__ */ new Set();
  for (const id of current) {
    const parts = id.split(".");
    if (parts.length >= 4 && (parts[1] === "limits" || parts[1] === "models")) {
      livingSubtrees.add(parts.slice(0, 3).join("."));
    }
  }
  const goneStates = known.filter((id) => {
    if (surviving.has(id)) {
      return false;
    }
    const parts = id.split(".");
    if (parts.length >= 4 && (parts[1] === "limits" || parts[1] === "models")) {
      return !livingSubtrees.has(parts.slice(0, 3).join("."));
    }
    return false;
  });
  const emptyChannels = /* @__PURE__ */ new Set();
  const remaining = /* @__PURE__ */ new Set([...surviving, ...known.filter((id) => !goneStates.includes(id))]);
  for (const id of goneStates) {
    const parts = id.split(".");
    for (let depth = parts.length - 1; depth >= 2; depth--) {
      const parent = parts.slice(0, depth).join(".");
      if (![...remaining].some((alive) => alive.startsWith(`${parent}.`))) {
        emptyChannels.add(parent);
      }
    }
  }
  return [...goneStates, ...[...emptyChannels].sort((a, b) => b.split(".").length - a.split(".").length)];
}
function maxLimitPercent(snapshot) {
  var _a;
  return (_a = limitingWindow(snapshot)) == null ? void 0 : _a.percent;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  limitingWindow,
  mapSnapshot,
  maxLimitPercent,
  orphanObjectIds
});
//# sourceMappingURL=snapshot-tree.js.map

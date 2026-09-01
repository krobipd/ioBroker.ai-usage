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
    channel(`${accountId}.limits`, "Limit windows");
    for (const limit of snapshot.limits) {
      const windowId = (0, import_pure_helpers.sanitizeId)(limit.name);
      if (!windowId) {
        continue;
      }
      channel(`${accountId}.limits.${windowId}`, limit.label);
      add(
        state(`${accountId}.limits.${windowId}.percent`, `${limit.label} used`, "number", "value", limit.percent, "%")
      );
      add(
        state(
          `${accountId}.limits.${windowId}.resetAt`,
          `${limit.label} resets at`,
          "string",
          "date",
          (_a = limit.resetAt) != null ? _a : ""
        )
      );
    }
  }
  const credits = snapshot.credits;
  if (credits) {
    channel(`${accountId}.credits`, "Credits");
    const unit = credits.pieces ? "" : credits.currency;
    if (credits.used !== void 0) {
      add(state(`${accountId}.credits.used`, "Credits used", "number", "value", credits.used, unit));
    }
    if (credits.limit !== void 0) {
      add(state(`${accountId}.credits.limit`, "Credits limit", "number", "value", credits.limit, unit));
    }
    if (credits.remaining !== void 0) {
      add(state(`${accountId}.credits.remaining`, "Credits remaining", "number", "value", credits.remaining, unit));
    }
    if (credits.percent !== void 0) {
      add(state(`${accountId}.credits.percent`, "Credits used (percent)", "number", "value", credits.percent, "%"));
    }
    if (credits.granted !== void 0) {
      add(state(`${accountId}.credits.granted`, "Granted balance", "number", "value", credits.granted, unit));
    }
    if (credits.toppedUp !== void 0) {
      add(state(`${accountId}.credits.toppedUp`, "Topped-up balance", "number", "value", credits.toppedUp, unit));
    }
    if (credits.resetCredits !== void 0) {
      add(
        state(
          `${accountId}.credits.resetCredits`,
          "Available limit-reset credits",
          "number",
          "value",
          credits.resetCredits
        )
      );
      add(
        state(
          `${accountId}.credits.resetCreditsNextExpiry`,
          "Next reset credit expires at",
          "string",
          "date",
          (_b = credits.resetCreditsNextExpiry) != null ? _b : ""
        )
      );
    }
  }
  const costs = snapshot.costs;
  if (costs) {
    channel(`${accountId}.costs`, "Costs");
    if (costs.today !== void 0) {
      add(state(`${accountId}.costs.today`, "Costs today", "number", "value", costs.today, costs.currency));
    }
    if (costs.month !== void 0) {
      add(state(`${accountId}.costs.month`, "Costs this month", "number", "value", costs.month, costs.currency));
    }
    if (costs.total !== void 0) {
      add(state(`${accountId}.costs.total`, "Costs total (lifetime)", "number", "value", costs.total, costs.currency));
    }
    if (costs.projectedMonth !== void 0) {
      add(
        state(
          `${accountId}.costs.projectedMonth`,
          "Costs projected month-end (computed)",
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
    channel(`${accountId}.tokens`, "Tokens");
    if (tokens.inputToday !== void 0) {
      add(state(`${accountId}.tokens.inputToday`, "Input tokens today", "number", "value", tokens.inputToday));
    }
    if (tokens.outputToday !== void 0) {
      add(state(`${accountId}.tokens.outputToday`, "Output tokens today", "number", "value", tokens.outputToday));
    }
    if (tokens.perModel && tokens.perModel.length > 0) {
      channel(`${accountId}.models`, "Per-model usage");
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
              `${model.model} tokens today`,
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
              `${model.model} costs today`,
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
    add(state(`${accountId}.available`, "Balance sufficient for calls", "boolean", "indicator", snapshot.available));
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

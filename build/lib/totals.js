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
var totals_exports = {};
__export(totals_exports, {
  computeTotals: () => computeTotals
});
module.exports = __toCommonJS(totals_exports);
var import_snapshot_tree = require("./snapshot-tree");
const TOTAL_CURRENCY = "USD";
function computeTotals(statuses) {
  var _a, _b, _c, _d;
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
      costsToday += (_a = costs.today) != null ? _a : 0;
      costsMonth += (_b = costs.month) != null ? _b : 0;
      costsProjectedMonth += (_d = (_c = costs.projectedMonth) != null ? _c : costs.month) != null ? _d : 0;
    }
    const percent = (0, import_snapshot_tree.maxLimitPercent)(snapshot);
    if (percent !== void 0) {
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
    accounts: statuses.length
  };
}
function round2(value) {
  return Math.round(value * 100) / 100;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  computeTotals
});
//# sourceMappingURL=totals.js.map

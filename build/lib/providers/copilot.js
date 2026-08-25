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
var copilot_exports = {};
__export(copilot_exports, {
  copilotProvider: () => copilotProvider,
  parseCopilotUsage: () => parseCopilotUsage
});
module.exports = __toCommonJS(copilot_exports);
var import_http = require("../http");
var import_provider = require("../provider");
function parseCopilotUsage(body) {
  const items = body == null ? void 0 : body.usageItems;
  if (!Array.isArray(items)) {
    throw new import_provider.FetchError("network", "unexpected response shape (no usageItems)");
  }
  let gross = 0;
  let discount = 0;
  let netAmount = 0;
  for (const item of items) {
    const data = item;
    const grossQuantity = Number(data.grossQuantity);
    const discountQuantity = Number(data.discountQuantity);
    const amount = Number(data.netAmount);
    if (Number.isFinite(grossQuantity)) {
      gross += grossQuantity;
    }
    if (Number.isFinite(discountQuantity)) {
      discount += discountQuantity;
    }
    if (Number.isFinite(amount)) {
      netAmount += amount;
    }
  }
  const round = (value) => Math.round(value * 100) / 100;
  const snapshot = {
    credits: { used: round(gross), granted: round(discount), currency: "requests", pieces: true }
  };
  if (netAmount > 0) {
    snapshot.costs = { month: round(netAmount), currency: "USD" };
  }
  return snapshot;
}
function copilotProvider(username, token, fetchJson = import_http.getJson) {
  return {
    kind: "copilot",
    fetch: async () => parseCopilotUsage(
      await fetchJson(
        `https://api.github.com/users/${encodeURIComponent(username)}/settings/billing/ai_credit/usage`,
        {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10"
        }
      )
    )
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  copilotProvider,
  parseCopilotUsage
});
//# sourceMappingURL=copilot.js.map

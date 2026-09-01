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
var openrouter_exports = {};
__export(openrouter_exports, {
  openRouterProvider: () => openRouterProvider,
  parseOpenRouterKeyInfo: () => parseOpenRouterKeyInfo
});
module.exports = __toCommonJS(openrouter_exports);
var import_http = require("../http");
var import_provider = require("../provider");
var import_pure_helpers = require("../pure-helpers");
function parseOpenRouterKeyInfo(body) {
  var _a, _b, _c;
  const data = body == null ? void 0 : body.data;
  if (typeof data !== "object" || data === null) {
    throw new import_provider.FetchError("service", "unexpected response shape (no data object)");
  }
  const info = data;
  const used = (0, import_pure_helpers.finiteNumber)((_a = info.usage) != null ? _a : info.credits_used);
  const limit = (0, import_pure_helpers.finiteNumber)((_b = info.limit) != null ? _b : info.credit_limit);
  const remaining = (_c = (0, import_pure_helpers.finiteNumber)(info.limit_remaining)) != null ? _c : used !== void 0 && limit !== void 0 ? (0, import_pure_helpers.round2)(limit - used) : void 0;
  const snapshot = {
    credits: {
      used,
      limit,
      remaining,
      percent: used !== void 0 && limit !== void 0 && limit > 0 ? (0, import_pure_helpers.round2)(used / limit * 100) : void 0,
      currency: "USD"
    }
  };
  if (used !== void 0) {
    snapshot.costs = { total: used, currency: "USD" };
  }
  return snapshot;
}
function openRouterProvider(apiKey, fetchJson = import_http.getJson) {
  return {
    kind: "openrouter",
    fetch: async () => parseOpenRouterKeyInfo(
      await fetchJson("https://openrouter.ai/api/v1/auth/key", { Authorization: `Bearer ${apiKey}` })
    )
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  openRouterProvider,
  parseOpenRouterKeyInfo
});
//# sourceMappingURL=openrouter.js.map

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
var deepseek_exports = {};
__export(deepseek_exports, {
  deepSeekProvider: () => deepSeekProvider,
  parseDeepSeekBalance: () => parseDeepSeekBalance
});
module.exports = __toCommonJS(deepseek_exports);
var import_http = require("../http");
var import_provider = require("../provider");
function parseDeepSeekBalance(body) {
  const obj = body;
  if (typeof obj !== "object" || obj === null || !Array.isArray(obj.balance_infos)) {
    throw new import_provider.FetchError("network", "unexpected response shape (no balance_infos)");
  }
  const first = obj.balance_infos.find((entry) => typeof entry === "object" && entry !== null);
  const snapshot = {};
  if (typeof obj.is_available === "boolean") {
    snapshot.available = obj.is_available;
  }
  if (first) {
    snapshot.credits = {
      remaining: parseAmount(first.total_balance),
      granted: parseAmount(first.granted_balance),
      toppedUp: parseAmount(first.topped_up_balance),
      currency: typeof first.currency === "string" ? first.currency : "USD"
    };
  }
  return snapshot;
}
function deepSeekProvider(apiKey, fetchJson = import_http.getJson) {
  return {
    kind: "deepseek",
    fetch: async () => parseDeepSeekBalance(
      await fetchJson("https://api.deepseek.com/user/balance", {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      })
    )
  };
}
function parseAmount(value) {
  const num = Number(value);
  return value !== null && value !== void 0 && value !== "" && Number.isFinite(num) ? num : void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  deepSeekProvider,
  parseDeepSeekBalance
});
//# sourceMappingURL=deepseek.js.map

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
var anthropic_api_exports = {};
__export(anthropic_api_exports, {
  anthropicApiProvider: () => anthropicApiProvider,
  parseAnthropicReports: () => parseAnthropicReports
});
module.exports = __toCommonJS(anthropic_api_exports);
var import_http = require("../http");
var import_pure_helpers = require("../pure-helpers");
var import_report_utils = require("./report-utils");
const BASE = "https://api.anthropic.com/v1/organizations";
function parseAnthropicReports(usageBuckets, costBuckets, nowMs) {
  var _a, _b;
  let costMonth = 0;
  let costToday = 0;
  for (const bucket of costBuckets) {
    const entry = bucket;
    if (!Array.isArray(entry == null ? void 0 : entry.results)) {
      continue;
    }
    let sum = 0;
    for (const result of entry.results) {
      const amount = Number(result == null ? void 0 : result.amount);
      if (Number.isFinite(amount)) {
        sum += amount;
      }
    }
    costMonth += sum;
    if ((0, import_report_utils.isToday)((_a = entry.starting_at) != null ? _a : entry.start_time, nowMs)) {
      costToday += sum;
    }
  }
  let inputToday = 0;
  let outputToday = 0;
  let sawUsageToday = false;
  for (const bucket of usageBuckets) {
    const entry = bucket;
    if (!Array.isArray(entry == null ? void 0 : entry.results) || !(0, import_report_utils.isToday)((_b = entry.starting_at) != null ? _b : entry.start_time, nowMs)) {
      continue;
    }
    sawUsageToday = true;
    for (const result of entry.results) {
      const data = result;
      const input = Number(data.uncached_input_tokens);
      const output = Number(data.output_tokens);
      if (Number.isFinite(input)) {
        inputToday += input;
      }
      if (Number.isFinite(output)) {
        outputToday += output;
      }
    }
  }
  const snapshot = {
    costs: {
      today: (0, import_pure_helpers.round2)(costToday),
      month: (0, import_pure_helpers.round2)(costMonth),
      projectedMonth: (0, import_report_utils.projectMonth)(costMonth, nowMs),
      currency: "USD"
    }
  };
  if (sawUsageToday) {
    snapshot.tokens = { inputToday, outputToday };
  }
  return snapshot;
}
function anthropicApiProvider(adminKey, fetchJson = import_http.getJson, now = Date.now, warn = () => void 0) {
  return {
    kind: "anthropic-api",
    fetch: async () => {
      const headers = { "x-api-key": adminKey, "anthropic-version": "2023-06-01" };
      const start = encodeURIComponent((0, import_report_utils.monthStartIso)(now()));
      const truncated = (report) => {
        return (pages) => warn(`the ${report} report was still offering more after ${pages} pages \u2014 this month's figures are partial`);
      };
      const usage = await (0, import_report_utils.fetchAllPages)(
        `${BASE}/usage_report/messages?starting_at=${start}&bucket_width=1d&limit=31`,
        headers,
        fetchJson,
        truncated("usage")
      );
      const costs = await (0, import_report_utils.fetchAllPages)(
        `${BASE}/cost_report?starting_at=${start}&bucket_width=1d&limit=31`,
        headers,
        fetchJson,
        truncated("cost")
      );
      return parseAnthropicReports(usage, costs, now());
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  anthropicApiProvider,
  parseAnthropicReports
});
//# sourceMappingURL=anthropic-api.js.map

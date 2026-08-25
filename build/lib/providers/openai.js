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
var openai_exports = {};
__export(openai_exports, {
  openAiProvider: () => openAiProvider,
  parseOpenAiReports: () => parseOpenAiReports
});
module.exports = __toCommonJS(openai_exports);
var import_http = require("../http");
var import_report_utils = require("./report-utils");
const BASE = "https://api.openai.com/v1/organization";
async function fetchAllPages(url, headers, fetchJson) {
  const buckets = [];
  let page;
  for (let i = 0; i < 12; i++) {
    const body = await fetchJson(page ? `${url}&page=${encodeURIComponent(page)}` : url, headers);
    if (Array.isArray(body == null ? void 0 : body.data)) {
      buckets.push(...body.data);
    }
    if ((body == null ? void 0 : body.has_more) !== true || typeof (body == null ? void 0 : body.next_page) !== "string" || !body.next_page) {
      break;
    }
    page = body.next_page;
  }
  return buckets;
}
function parseOpenAiReports(usageBuckets, costBuckets, nowMs) {
  var _a;
  let costMonth = 0;
  let costToday = 0;
  let currency = "USD";
  for (const bucket of costBuckets) {
    const entry = bucket;
    if (!Array.isArray(entry == null ? void 0 : entry.results)) {
      continue;
    }
    let sum = 0;
    for (const result of entry.results) {
      const amount = result == null ? void 0 : result.amount;
      const value = Number(amount == null ? void 0 : amount.value);
      if (Number.isFinite(value)) {
        sum += value;
      }
      if (typeof (amount == null ? void 0 : amount.currency) === "string" && amount.currency) {
        currency = amount.currency.toUpperCase();
      }
    }
    costMonth += sum;
    if ((0, import_report_utils.isToday)(entry.start_time, nowMs)) {
      costToday += sum;
    }
  }
  let inputToday = 0;
  let outputToday = 0;
  const perModel = /* @__PURE__ */ new Map();
  let sawUsageToday = false;
  for (const bucket of usageBuckets) {
    const entry = bucket;
    if (!Array.isArray(entry == null ? void 0 : entry.results) || !(0, import_report_utils.isToday)(entry.start_time, nowMs)) {
      continue;
    }
    sawUsageToday = true;
    for (const result of entry.results) {
      const data = result;
      const input = Number(data.input_tokens);
      const output = Number(data.output_tokens);
      if (Number.isFinite(input)) {
        inputToday += input;
      }
      if (Number.isFinite(output)) {
        outputToday += output;
      }
      if (typeof data.model === "string" && data.model) {
        const tokens = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
        const existing = (_a = perModel.get(data.model)) != null ? _a : { tokens: 0 };
        existing.tokens += tokens;
        perModel.set(data.model, existing);
      }
    }
  }
  const round = (value) => Math.round(value * 100) / 100;
  const snapshot = {
    costs: {
      today: round(costToday),
      month: round(costMonth),
      projectedMonth: (0, import_report_utils.projectMonth)(costMonth, nowMs),
      currency
    }
  };
  if (sawUsageToday) {
    snapshot.tokens = {
      inputToday,
      outputToday,
      perModel: [...perModel.entries()].map(([model, data]) => ({ model, tokens: data.tokens }))
    };
  }
  return snapshot;
}
function openAiProvider(adminKey, fetchJson = import_http.getJson, now = Date.now) {
  return {
    kind: "openai",
    fetch: async () => {
      const headers = { Authorization: `Bearer ${adminKey}` };
      const start = (0, import_report_utils.monthStartUnix)(now());
      const usage = await fetchAllPages(
        `${BASE}/usage/completions?start_time=${start}&bucket_width=1d&limit=31&group_by=model`,
        headers,
        fetchJson
      );
      const costs = await fetchAllPages(`${BASE}/costs?start_time=${start}&limit=31`, headers, fetchJson);
      return parseOpenAiReports(usage, costs, now());
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  openAiProvider,
  parseOpenAiReports
});
//# sourceMappingURL=openai.js.map

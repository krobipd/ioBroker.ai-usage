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
var report_utils_exports = {};
__export(report_utils_exports, {
  fetchAllPages: () => fetchAllPages,
  isToday: () => isToday,
  monthStartIso: () => monthStartIso,
  monthStartUnix: () => monthStartUnix,
  projectMonth: () => projectMonth
});
module.exports = __toCommonJS(report_utils_exports);
const MAX_REPORT_PAGES = 32;
async function fetchAllPages(url, headers, fetchJson, onTruncated) {
  const buckets = [];
  let page;
  for (let i = 0; i < MAX_REPORT_PAGES; i++) {
    const body = await fetchJson(page ? `${url}&page=${encodeURIComponent(page)}` : url, headers);
    if (Array.isArray(body == null ? void 0 : body.data)) {
      buckets.push(...body.data);
    }
    if ((body == null ? void 0 : body.has_more) !== true || typeof (body == null ? void 0 : body.next_page) !== "string" || !body.next_page) {
      return buckets;
    }
    page = body.next_page;
  }
  onTruncated == null ? void 0 : onTruncated(MAX_REPORT_PAGES);
  return buckets;
}
function monthStartUnix(nowMs) {
  const now = new Date(nowMs);
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1e3);
}
function monthStartIso(nowMs) {
  return new Date(monthStartUnix(nowMs) * 1e3).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function isToday(bucketStart, nowMs) {
  let date;
  if (typeof bucketStart === "number") {
    date = new Date(bucketStart * 1e3);
  } else if (typeof bucketStart === "string" && bucketStart) {
    date = new Date(bucketStart);
  } else {
    return false;
  }
  const now = new Date(nowMs);
  return date.getUTCFullYear() === now.getUTCFullYear() && date.getUTCMonth() === now.getUTCMonth() && date.getUTCDate() === now.getUTCDate();
}
function projectMonth(monthSum, nowMs) {
  const now = new Date(nowMs);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = now.getUTCDate();
  return Math.round(monthSum / dayOfMonth * daysInMonth * 100) / 100;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  fetchAllPages,
  isToday,
  monthStartIso,
  monthStartUnix,
  projectMonth
});
//# sourceMappingURL=report-utils.js.map

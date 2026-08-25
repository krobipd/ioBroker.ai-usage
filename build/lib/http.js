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
var http_exports = {};
__export(http_exports, {
  getJson: () => getJson
});
module.exports = __toCommonJS(http_exports);
var import_provider = require("./provider");
const REQUEST_TIMEOUT_MS = 15e3;
async function getJson(url, headers) {
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    throw new import_provider.FetchError("network", e instanceof Error ? e.message : String(e));
  }
  if (response.status === 401 || response.status === 403) {
    throw new import_provider.FetchError("auth", `HTTP ${response.status}`);
  }
  if (response.status === 429) {
    throw new import_provider.FetchError("rate-limit", "HTTP 429");
  }
  if (!response.ok) {
    throw new import_provider.FetchError("network", `HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new import_provider.FetchError("network", "invalid JSON response");
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getJson
});
//# sourceMappingURL=http.js.map

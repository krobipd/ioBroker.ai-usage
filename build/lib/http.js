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
  getJson: () => getJson,
  postForm: () => postForm,
  postJson: () => postJson
});
module.exports = __toCommonJS(http_exports);
var import_provider = require("./provider");
const REQUEST_TIMEOUT_MS = 15e3;
async function request(url, init, authOn400 = false) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    throw new import_provider.FetchError("network", e instanceof Error ? e.message : String(e));
  }
  if (response.status === 401 || response.status === 403 || authOn400 && response.status === 400) {
    throw new import_provider.FetchError("auth", `HTTP ${response.status}`);
  }
  if (response.status === 429) {
    throw new import_provider.FetchError("rate-limit", "HTTP 429");
  }
  if (!response.ok) {
    throw new import_provider.FetchError("service", `HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (e) {
    throw new import_provider.FetchError("service", `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}
async function getJson(url, headers) {
  return request(url, { headers });
}
async function postJson(url, body) {
  return request(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    true
  );
}
async function postForm(url, form, headers = {}) {
  return request(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form).toString()
    },
    true
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getJson,
  postForm,
  postJson
});
//# sourceMappingURL=http.js.map

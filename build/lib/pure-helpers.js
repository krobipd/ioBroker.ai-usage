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
var pure_helpers_exports = {};
__export(pure_helpers_exports, {
  PROVIDER_KINDS: () => PROVIDER_KINDS,
  clampPollInterval: () => clampPollInterval,
  parseAccounts: () => parseAccounts,
  sanitizeId: () => sanitizeId
});
module.exports = __toCommonJS(pure_helpers_exports);
function sanitizeId(name) {
  return name.trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
}
const PROVIDER_KINDS = ["claude-sub", "openrouter", "deepseek", "openai", "anthropic-api", "copilot"];
function parseAccounts(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const accounts = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const row = entry;
    if (row.enabled === false) {
      continue;
    }
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const id = sanitizeId(name);
    const provider = typeof row.provider === "string" ? row.provider : "";
    if (!id || id === "info" || id === "total" || !PROVIDER_KINDS.includes(provider) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const threshold = Number(row.warnThreshold);
    accounts.push({
      name,
      id,
      provider,
      credentialId: typeof row.credentialId === "string" ? row.credentialId : "",
      warnThreshold: Number.isFinite(threshold) && threshold >= 10 && threshold <= 100 ? threshold : 80
    });
  }
  return accounts;
}
function clampPollInterval(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return 300;
  }
  return Math.min(3600, Math.max(60, Math.round(value)));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PROVIDER_KINDS,
  clampPollInterval,
  parseAccounts,
  sanitizeId
});
//# sourceMappingURL=pure-helpers.js.map

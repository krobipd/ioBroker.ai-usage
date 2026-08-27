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
  RESERVED_ROOT_IDS: () => RESERVED_ROOT_IDS,
  SUBSCRIPTION_IDS: () => SUBSCRIPTION_IDS,
  accountId: () => accountId,
  clampPollInterval: () => clampPollInterval,
  datapointBalanceLine: () => datapointBalanceLine,
  finiteNumber: () => finiteNumber,
  parseAccounts: () => parseAccounts,
  round2: () => round2,
  sanitizeId: () => sanitizeId
});
module.exports = __toCommonJS(pure_helpers_exports);
function sanitizeId(name) {
  return name.trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
}
const PROVIDER_KINDS = [
  "claude-sub",
  "chatgpt-sub",
  "gemini-sub",
  "openrouter",
  "deepseek",
  "openai",
  "anthropic-api"
];
const SUBSCRIPTION_IDS = {
  "claude-sub": "claude",
  "chatgpt-sub": "chatgpt",
  "gemini-sub": "gemini"
};
const RESERVED_ROOT_IDS = ["info", "total"];
function accountId(provider, credentialId) {
  const fixed = SUBSCRIPTION_IDS[provider];
  if (fixed) {
    return fixed;
  }
  const suffix = sanitizeId(credentialId.replace(/^system\.credentials\./, ""));
  return suffix ? `${suffix}-api` : "";
}
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
    const provider = typeof row.provider === "string" ? row.provider : "";
    const credentialId = typeof row.credentialId === "string" ? row.credentialId : "";
    const id = accountId(provider, credentialId);
    const name = (typeof row.name === "string" ? row.name.trim() : "") || id;
    if (!id || RESERVED_ROOT_IDS.includes(id) || !PROVIDER_KINDS.includes(provider) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const threshold = Number(row.warnThreshold);
    accounts.push({
      name,
      id,
      provider,
      credentialId,
      warnThreshold: Number.isFinite(threshold) && threshold >= 10 && threshold <= 100 ? threshold : 80
    });
  }
  return accounts;
}
function round2(value) {
  return Math.round(value * 100) / 100;
}
function finiteNumber(value) {
  if (value === null || value === void 0 || value === "") {
    return void 0;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : void 0;
}
function clampPollInterval(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return 300;
  }
  return Math.min(3600, Math.max(60, Math.round(value)));
}
function datapointBalanceLine(created, removed) {
  const parts = [];
  if (created > 0) {
    parts.push(`created ${created} datapoint(s)`);
  }
  if (removed > 0) {
    parts.push(`removed ${removed} datapoint(s)`);
  }
  return parts.length ? `Object tree updated: ${parts.join(", ")}` : null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PROVIDER_KINDS,
  RESERVED_ROOT_IDS,
  SUBSCRIPTION_IDS,
  accountId,
  clampPollInterval,
  datapointBalanceLine,
  finiteNumber,
  parseAccounts,
  round2,
  sanitizeId
});
//# sourceMappingURL=pure-helpers.js.map

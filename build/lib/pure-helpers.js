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
  SUBSCRIPTION_KINDS: () => SUBSCRIPTION_KINDS,
  accountId: () => accountId,
  clampPollInterval: () => clampPollInterval,
  datapointBalanceLine: () => datapointBalanceLine,
  parseAccounts: () => parseAccounts,
  sanitizeId: () => sanitizeId,
  validAccountIds: () => validAccountIds
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
const SUBSCRIPTION_KINDS = ["claude-sub", "chatgpt-sub", "gemini-sub"];
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
    if (row.enabled === false) {
      continue;
    }
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
function validAccountIds(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const ids = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const row = entry;
    const id = accountId(
      typeof row.provider === "string" ? row.provider : "",
      typeof row.credentialId === "string" ? row.credentialId : ""
    );
    if (id && !RESERVED_ROOT_IDS.includes(id) && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
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
  SUBSCRIPTION_KINDS,
  accountId,
  clampPollInterval,
  datapointBalanceLine,
  parseAccounts,
  sanitizeId,
  validAccountIds
});
//# sourceMappingURL=pure-helpers.js.map

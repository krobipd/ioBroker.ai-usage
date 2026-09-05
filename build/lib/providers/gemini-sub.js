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
var gemini_sub_exports = {};
__export(gemini_sub_exports, {
  GEMINI_HOSTS: () => GEMINI_HOSTS,
  GEMINI_IDENTITY: () => GEMINI_IDENTITY,
  geminiSubProvider: () => geminiSubProvider,
  parseCodeAssist: () => parseCodeAssist,
  parseGeminiQuota: () => parseGeminiQuota
});
module.exports = __toCommonJS(gemini_sub_exports);
var import_provider = require("../provider");
var import_gemini_auth = require("./gemini-auth");
var import_pure_helpers = require("../pure-helpers");
const GEMINI_HOSTS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal",
  "https://cloudcode-pa.googleapis.com/v1internal"
];
const GEMINI_IDENTITY = {
  ideType: "ANTIGRAVITY",
  userAgent: "antigravity/1.11.3"
};
async function callCodeAssist(method, body, accessToken, post) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": GEMINI_IDENTITY.userAgent
  };
  let lastError;
  for (const host of GEMINI_HOSTS) {
    try {
      return await post(`${host}:${method}`, body, headers);
    } catch (e) {
      if (e instanceof import_provider.FetchError && e.kind === "auth") {
        throw e;
      }
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new import_provider.FetchError("network", "no Code-Assist host answered");
}
function parseCodeAssist(body) {
  var _a, _b;
  const raw = typeof body === "object" && body !== null ? body : {};
  const project = typeof raw.cloudaicompanionProject === "string" ? raw.cloudaicompanionProject : "";
  const paid = (_a = raw.paidTier) != null ? _a : {};
  const current = (_b = raw.currentTier) != null ? _b : {};
  const tier = typeof paid.name === "string" && paid.name || typeof current.name === "string" && current.name || typeof paid.id === "string" && paid.id || typeof current.id === "string" && current.id || "";
  return { project, tier };
}
function parseGeminiQuota(body) {
  if (typeof body !== "object" || body === null) {
    throw new import_provider.FetchError("service", "unexpected quota response");
  }
  const raw = body;
  const buckets = Array.isArray(raw.buckets) ? raw.buckets : [];
  const limits = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of buckets) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const bucket = entry;
    const fraction = Number(bucket.remainingFraction);
    if (!Number.isFinite(fraction)) {
      continue;
    }
    const model = typeof bucket.modelId === "string" ? bucket.modelId : "";
    const kind = typeof bucket.tokenType === "string" ? bucket.tokenType.toLowerCase() : "";
    const name = (0, import_pure_helpers.sanitizeId)(model || kind || "quota");
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const window = {
      name,
      label: model || kind || "Quota",
      // Google names every bucket after a model — the model is the foreign part,
      // the frame around it is translated.
      labelKey: "nameWindowQuota",
      labelArg: model || kind || "",
      percent: Math.round((1 - Math.min(Math.max(fraction, 0), 1)) * 1e3) / 10,
      scoped: true
    };
    if (typeof bucket.resetTime === "string" && bucket.resetTime) {
      window.resetAt = bucket.resetTime;
    }
    limits.push(window);
  }
  return limits.length ? { limits } : {};
}
function geminiSubProvider(store, post, postForm, now = Date.now) {
  return {
    kind: "gemini-sub",
    fetch: async () => {
      let tokens = await store.load();
      if (!tokens) {
        throw new import_provider.FetchError("auth", "not signed in \u2014 start the Google sign-in in the instance settings");
      }
      if (now() >= tokens.expiresAt - 6e4) {
        tokens = await (0, import_gemini_auth.refreshGeminiTokens)(tokens, postForm, now());
        await store.save(tokens);
      }
      if (!tokens.accountRef) {
        const info = parseCodeAssist(
          await callCodeAssist(
            "loadCodeAssist",
            { metadata: { ideType: GEMINI_IDENTITY.ideType } },
            tokens.accessToken,
            post
          )
        );
        if (!info.project) {
          throw new import_provider.FetchError(
            "auth",
            "Google returned no project for this account \u2014 a Google AI subscription (Pro/Ultra) is required"
          );
        }
        tokens = { ...tokens, accountRef: info.project };
        await store.save(tokens);
      }
      return parseGeminiQuota(
        await callCodeAssist("retrieveUserQuota", { project: tokens.accountRef }, tokens.accessToken, post)
      );
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GEMINI_HOSTS,
  GEMINI_IDENTITY,
  geminiSubProvider,
  parseCodeAssist,
  parseGeminiQuota
});
//# sourceMappingURL=gemini-sub.js.map

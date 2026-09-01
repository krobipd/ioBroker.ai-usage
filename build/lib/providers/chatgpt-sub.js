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
var chatgpt_sub_exports = {};
__export(chatgpt_sub_exports, {
  CHATGPT_OAUTH: () => import_chatgpt_auth.CHATGPT_OAUTH,
  CHATGPT_RESET_CREDITS_URL: () => CHATGPT_RESET_CREDITS_URL,
  CHATGPT_USAGE_URL: () => CHATGPT_USAGE_URL,
  chatgptSubProvider: () => chatgptSubProvider,
  parseChatgptResetCredits: () => parseChatgptResetCredits,
  parseChatgptUsage: () => parseChatgptUsage
});
module.exports = __toCommonJS(chatgpt_sub_exports);
var import_http = require("../http");
var import_provider = require("../provider");
var import_chatgpt_auth = require("./chatgpt-auth");
const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
function readWindow(raw, name, label) {
  if (typeof raw !== "object" || raw === null) {
    return void 0;
  }
  const entry = raw;
  const percent = Number(entry.used_percent);
  if (!Number.isFinite(percent)) {
    return void 0;
  }
  const window = { name, label, percent };
  const resetAt = Number(entry.reset_at);
  if (Number.isFinite(resetAt) && resetAt > 0) {
    const ms = resetAt > 1e12 ? resetAt : resetAt * 1e3;
    window.resetAt = new Date(ms).toISOString();
  }
  return window;
}
function parseChatgptUsage(body) {
  var _a, _b;
  if (typeof body !== "object" || body === null) {
    throw new import_provider.FetchError("service", "unexpected usage response");
  }
  const raw = body;
  const limits = [];
  const rateLimit = (_a = raw.rate_limit) != null ? _a : {};
  const session = readWindow(rateLimit.primary_window, "session", "Session (5 h)");
  const week = readWindow(rateLimit.secondary_window, "week", "Week");
  if (session) {
    limits.push(session);
  }
  if (week) {
    limits.push(week);
  }
  for (const extra of Array.isArray(raw.additional_rate_limits) ? raw.additional_rate_limits : []) {
    if (typeof extra !== "object" || extra === null) {
      continue;
    }
    const entry = extra;
    const label = typeof entry.limit_name === "string" ? entry.limit_name : "";
    const name = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!name || limits.some((window2) => window2.name === name)) {
      continue;
    }
    const window = readWindow(entry.rate_limit, name, label);
    if (window) {
      window.scoped = true;
      limits.push(window);
    }
  }
  const snapshot = {};
  if (limits.length) {
    snapshot.limits = limits;
  }
  const credits = (_b = raw.credits) != null ? _b : {};
  const balance = Number(credits.balance);
  if (Number.isFinite(balance) && credits.unlimited !== true) {
    snapshot.credits = { remaining: balance, currency: "USD" };
  }
  return snapshot;
}
function parseChatgptResetCredits(body, nowMs) {
  const raw = typeof body === "object" && body !== null ? body : {};
  const list = Array.isArray(raw.credits) ? raw.credits : null;
  if (!list) {
    const serverCount = Number(raw.available_count);
    return { count: Number.isFinite(serverCount) && serverCount >= 0 ? serverCount : 0, nextExpiry: "" };
  }
  let count = 0;
  let nextExpiry = "";
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const voucher = entry;
    if (voucher.status !== "available") {
      continue;
    }
    const expiresAt = typeof voucher.expires_at === "string" ? voucher.expires_at : "";
    if (expiresAt) {
      const expiryMs = Date.parse(expiresAt);
      if (Number.isFinite(expiryMs) && expiryMs <= nowMs) {
        continue;
      }
      if (!nextExpiry || expiresAt < nextExpiry) {
        nextExpiry = expiresAt;
      }
    }
    count++;
  }
  return { count, nextExpiry };
}
function chatgptSubProvider(store, postJson, fetchJson = import_http.getJson, now = Date.now) {
  return {
    kind: "chatgpt-sub",
    fetch: async () => {
      var _a;
      let tokens = await store.load();
      if (!tokens) {
        throw new import_provider.FetchError("auth", "not signed in \u2014 start the ChatGPT sign-in in the instance settings");
      }
      if (now() >= tokens.expiresAt - 6e4) {
        tokens = await (0, import_chatgpt_auth.refreshChatgptTokens)(tokens, postJson, now());
        await store.save(tokens);
      }
      const headers = {
        Authorization: `Bearer ${tokens.accessToken}`,
        "User-Agent": "ioBroker.ai-usage"
      };
      if (tokens.accountRef) {
        headers["ChatGPT-Account-Id"] = tokens.accountRef;
      }
      const snapshot = parseChatgptUsage(await fetchJson(CHATGPT_USAGE_URL, headers));
      try {
        const vouchers = parseChatgptResetCredits(
          await fetchJson(CHATGPT_RESET_CREDITS_URL, {
            ...headers,
            // What OpenAI's own desktop client sends on this route (CodexBar-verified).
            "OpenAI-Beta": "codex-1",
            originator: "Codex Desktop"
          }),
          now()
        );
        const credits = (_a = snapshot.credits) != null ? _a : { currency: "USD" };
        credits.resetCredits = vouchers.count;
        credits.resetCreditsNextExpiry = vouchers.nextExpiry;
        snapshot.credits = credits;
      } catch {
      }
      return snapshot;
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHATGPT_OAUTH,
  CHATGPT_RESET_CREDITS_URL,
  CHATGPT_USAGE_URL,
  chatgptSubProvider,
  parseChatgptResetCredits,
  parseChatgptUsage
});
//# sourceMappingURL=chatgpt-sub.js.map

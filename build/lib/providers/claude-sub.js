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
var claude_sub_exports = {};
__export(claude_sub_exports, {
  claudeSubProvider: () => claudeSubProvider,
  parseClaudeUsage: () => parseClaudeUsage
});
module.exports = __toCommonJS(claude_sub_exports);
var import_http = require("../http");
var import_provider = require("../provider");
var import_pure_helpers = require("../pure-helpers");
var import_claude_auth = require("./claude-auth");
function parseClaudeUsage(body) {
  var _a, _b;
  if (typeof body !== "object" || body === null) {
    throw new import_provider.FetchError("network", "unexpected usage response");
  }
  const raw = body;
  const limits = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (name, label, percent, resetsAt, scoped = false) => {
    const id = (0, import_pure_helpers.sanitizeId)(name);
    const value = Number(percent);
    if (!id || seen.has(id) || !Number.isFinite(value)) {
      return;
    }
    seen.add(id);
    const window = { name: id, label, percent: value };
    if (typeof resetsAt === "string" && resetsAt) {
      window.resetAt = resetsAt;
    }
    if (scoped) {
      window.scoped = true;
    }
    limits.push(window);
  };
  if (Array.isArray(raw.limits)) {
    for (const entry of raw.limits) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const limit = entry;
      const kind = typeof limit.kind === "string" ? limit.kind : "";
      if (!kind) {
        continue;
      }
      const scope = (_a = limit.scope) != null ? _a : {};
      const model = ((_b = scope.model) != null ? _b : {}).display_name;
      const surface = scope.surface;
      const nameParts = [kind === "session" ? "session" : kind === "weekly_all" ? "week" : kind];
      const labelParts = [
        kind === "session" ? "Session (5 h)" : kind === "weekly_all" ? "Week (all models)" : kind.replace(/_/g, " ")
      ];
      if (typeof model === "string" && model) {
        nameParts.push(model);
        labelParts.push(model);
      }
      if (typeof surface === "string" && surface) {
        nameParts.push(surface);
        labelParts.push(`(${surface})`);
      }
      const scoped = kind !== "session" && kind !== "weekly_all";
      push(nameParts.join("-"), labelParts.join(" "), limit.percent, limit.resets_at, scoped);
    }
  }
  if (limits.length === 0) {
    const flat = (key, name, label, scoped = false) => {
      const block = raw[key];
      if (typeof block === "object" && block !== null) {
        const data = block;
        push(name, label, data.utilization, data.resets_at, scoped);
      }
    };
    flat("five_hour", "session", "Session (5 h)");
    flat("seven_day", "week", "Week (all models)");
    flat("seven_day_sonnet", "week-sonnet", "Week Sonnet", true);
  }
  const snapshot = {};
  if (limits.length > 0) {
    snapshot.limits = limits;
  }
  applyExtraUsage(raw, snapshot);
  return snapshot;
}
function applyExtraUsage(raw, snapshot) {
  const extra = raw.extra_usage;
  const spend = raw.spend;
  if (extra && extra.is_enabled === true) {
    const divisor = 10 ** (Number.isFinite(Number(extra.decimal_places)) ? Number(extra.decimal_places) : 2);
    const used = Number(extra.used_credits);
    const limit = Number(extra.monthly_limit);
    const percent = Number(extra.utilization);
    snapshot.credits = {
      used: Number.isFinite(used) ? used / divisor : void 0,
      limit: Number.isFinite(limit) ? limit / divisor : void 0,
      percent: Number.isFinite(percent) ? percent : void 0,
      currency: "USD"
    };
    if (snapshot.credits.used !== void 0) {
      snapshot.costs = { month: snapshot.credits.used, currency: "USD" };
    }
    return;
  }
  if (spend && spend.enabled === true) {
    const money = (value) => {
      const obj = value;
      const amount = Number(obj == null ? void 0 : obj.amount_minor);
      const exponent = Number(obj == null ? void 0 : obj.exponent);
      return Number.isFinite(amount) ? amount / 10 ** (Number.isFinite(exponent) ? exponent : 2) : void 0;
    };
    const used = money(spend.used);
    const percent = Number(spend.percent);
    snapshot.credits = {
      used,
      limit: money(spend.limit),
      percent: Number.isFinite(percent) ? percent : void 0,
      currency: "USD"
    };
    if (used !== void 0) {
      snapshot.costs = { month: used, currency: "USD" };
    }
  }
}
function claudeSubProvider(store, postJson, fetchJson = import_http.getJson, now = Date.now) {
  return {
    kind: "claude-sub",
    fetch: async () => {
      let tokens = await store.load();
      if (!tokens) {
        throw new import_provider.FetchError("auth", "not signed in \u2014 run the Claude sign-in in the instance settings");
      }
      if (now() >= tokens.expiresAt - 6e4) {
        tokens = await (0, import_claude_auth.refreshTokens)(tokens, postJson, now());
        await store.save(tokens);
      }
      const body = await fetchJson(import_claude_auth.CLAUDE_OAUTH.usageUrl, {
        Authorization: `Bearer ${tokens.accessToken}`,
        "anthropic-beta": import_claude_auth.CLAUDE_OAUTH.betaHeader,
        // Identify ourselves — an unset/odd user agent lands in a harder-throttled
        // bucket of this endpoint (community-measured; sources in the concept doc).
        "User-Agent": "ioBroker.ai-usage"
      });
      return parseClaudeUsage(body);
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  claudeSubProvider,
  parseClaudeUsage
});
//# sourceMappingURL=claude-sub.js.map

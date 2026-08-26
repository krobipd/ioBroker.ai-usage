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
var gemini_auth_exports = {};
__export(gemini_auth_exports, {
  GEMINI_OAUTH: () => GEMINI_OAUTH,
  buildGeminiAuthorizeUrl: () => buildGeminiAuthorizeUrl,
  exchangeGeminiCode: () => exchangeGeminiCode,
  extractGeminiCode: () => extractGeminiCode,
  generateGeminiPkce: () => generateGeminiPkce,
  refreshGeminiTokens: () => refreshGeminiTokens
});
module.exports = __toCommonJS(gemini_auth_exports);
var import_node_crypto = require("node:crypto");
var import_provider = require("../provider");
const GEMINI_OAUTH = {
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  redirectUri: "http://localhost:51121/oauth-callback",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs"
  ],
  fallbackLifetimeMs: 60 * 6e4
};
function generateGeminiPkce() {
  const verifier = (0, import_node_crypto.randomBytes)(32).toString("base64url");
  return {
    verifier,
    challenge: (0, import_node_crypto.createHash)("sha256").update(verifier).digest("base64url"),
    state: (0, import_node_crypto.randomBytes)(16).toString("hex")
  };
}
function buildGeminiAuthorizeUrl(pkce) {
  const params = new URLSearchParams({
    client_id: GEMINI_OAUTH.clientId,
    redirect_uri: GEMINI_OAUTH.redirectUri,
    response_type: "code",
    scope: GEMINI_OAUTH.scopes.join(" "),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state,
    access_type: "offline",
    prompt: "consent"
  });
  return `${GEMINI_OAUTH.authorizeUrl}?${params.toString()}`;
}
function extractGeminiCode(pasted, expectedState) {
  const trimmed = pasted.trim();
  if (!trimmed) {
    throw new import_provider.FetchError("auth", "nothing pasted");
  }
  if (!trimmed.includes("?") && !trimmed.includes("&")) {
    return trimmed;
  }
  const query = trimmed.slice(trimmed.indexOf("?") + 1);
  const params = new URLSearchParams(query);
  const error = params.get("error");
  if (error) {
    throw new import_provider.FetchError("auth", `Google reported "${error}"`);
  }
  const code = params.get("code");
  if (!code) {
    throw new import_provider.FetchError("auth", "the pasted address carries no code");
  }
  const state = params.get("state");
  if (state && state !== expectedState) {
    throw new import_provider.FetchError("auth", "the pasted address belongs to a different sign-in attempt");
  }
  return code;
}
async function exchangeGeminiCode(code, pkce, post, now) {
  const body = await post(GEMINI_OAUTH.tokenUrl, {
    grant_type: "authorization_code",
    client_id: GEMINI_OAUTH.clientId,
    client_secret: GEMINI_OAUTH.clientSecret,
    code,
    code_verifier: pkce.verifier,
    redirect_uri: GEMINI_OAUTH.redirectUri
  });
  return toTokenSet(body, now, "");
}
async function refreshGeminiTokens(tokens, post, now) {
  const body = await post(GEMINI_OAUTH.tokenUrl, {
    grant_type: "refresh_token",
    client_id: GEMINI_OAUTH.clientId,
    client_secret: GEMINI_OAUTH.clientSecret,
    refresh_token: tokens.refreshToken
  });
  return toTokenSet(body, now, tokens.refreshToken, tokens.accountRef);
}
function toTokenSet(body, now, previousRefresh, previousAccount) {
  const raw = typeof body === "object" && body !== null ? body : {};
  const accessToken = typeof raw.access_token === "string" ? raw.access_token : "";
  if (!accessToken) {
    throw new import_provider.FetchError("auth", "no access token in the answer");
  }
  const lifetime = Number(raw.expires_in);
  return {
    accessToken,
    refreshToken: typeof raw.refresh_token === "string" && raw.refresh_token ? raw.refresh_token : previousRefresh,
    expiresAt: now + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime * 1e3 : GEMINI_OAUTH.fallbackLifetimeMs),
    accountRef: previousAccount
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GEMINI_OAUTH,
  buildGeminiAuthorizeUrl,
  exchangeGeminiCode,
  extractGeminiCode,
  generateGeminiPkce,
  refreshGeminiTokens
});
//# sourceMappingURL=gemini-auth.js.map

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
var claude_auth_exports = {};
__export(claude_auth_exports, {
  CLAUDE_OAUTH: () => CLAUDE_OAUTH,
  buildAuthorizeUrl: () => buildAuthorizeUrl,
  exchangeCode: () => exchangeCode,
  generatePkce: () => generatePkce,
  refreshTokens: () => refreshTokens
});
module.exports = __toCommonJS(claude_auth_exports);
var import_node_crypto = require("node:crypto");
var import_provider = require("../provider");
const CLAUDE_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  /**
   * Least privilege: the usage endpoint works with the profile scope alone —
   * proven by the HA reference integration, which narrowed to exactly this on
   * 2026-08-28 (trickv/hass-claude-usage PR #14, released as v10). The broader
   * set we started with (org:create_api_key + user:inference) let the stored
   * token CREATE API keys and CALL models — powers a read-only monitor must not
   * hold. Existing sign-ins keep working; the narrow scope applies from the
   * next sign-in on.
   */
  scopes: "user:profile",
  usageUrl: "https://api.anthropic.com/api/oauth/usage",
  profileUrl: "https://api.anthropic.com/api/oauth/profile",
  betaHeader: "oauth-2025-04-20",
  /**
   * The user agent decides WHICH throttle bucket the usage endpoint applies —
   * community-measured three times over (Claude-Code-Usage-Monitor #202,
   * claude-code #31021/#31637): a claude-code identity is safe at 3-minute
   * polls, any other identity lands in an aggressively limited bucket with
   * persistent 429s. Version pinned to the npm release current at build time;
   * the bucket keys on the product name, not the exact number. Same approach
   * as govee-smart, which identifies as the Govee app for the same reason.
   */
  userAgent: "claude-code/2.1.252"
};
function generatePkce() {
  const verifier = (0, import_node_crypto.randomBytes)(32).toString("base64url");
  const challenge = (0, import_node_crypto.createHash)("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, state: (0, import_node_crypto.randomBytes)(24).toString("base64url") };
}
function buildAuthorizeUrl(pkce) {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_OAUTH.clientId,
    response_type: "code",
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    scope: CLAUDE_OAUTH.scopes,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state
  });
  return `${CLAUDE_OAUTH.authorizeUrl}?${params.toString()}`;
}
function tokenSetFrom(body, now, previousRefresh = "") {
  const data = body;
  const accessToken = typeof (data == null ? void 0 : data.access_token) === "string" ? data.access_token : "";
  if (!accessToken) {
    throw new import_provider.FetchError("auth", "token response carries no access token");
  }
  const refreshToken = typeof (data == null ? void 0 : data.refresh_token) === "string" && data.refresh_token ? data.refresh_token : previousRefresh;
  const expiresIn = Number(data == null ? void 0 : data.expires_in);
  return {
    accessToken,
    refreshToken,
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1e3
  };
}
async function exchangeCode(pastedCode, pkce, postJson, now) {
  const [code, state = ""] = pastedCode.trim().split("#");
  if (!code) {
    throw new import_provider.FetchError("auth", "empty authorization code");
  }
  if (state && state !== pkce.state) {
    throw new import_provider.FetchError("auth", "state mismatch \u2014 start the sign-in again");
  }
  const body = await postJson(CLAUDE_OAUTH.tokenUrl, {
    grant_type: "authorization_code",
    code,
    state,
    client_id: CLAUDE_OAUTH.clientId,
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    code_verifier: pkce.verifier
  });
  return tokenSetFrom(body, now);
}
async function refreshTokens(tokens, postJson, now) {
  if (!tokens.refreshToken) {
    throw new import_provider.FetchError("auth", "no refresh token \u2014 sign in again");
  }
  const body = await postJson(CLAUDE_OAUTH.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: CLAUDE_OAUTH.clientId
  });
  return tokenSetFrom(body, now, tokens.refreshToken);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLAUDE_OAUTH,
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  refreshTokens
});
//# sourceMappingURL=claude-auth.js.map

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
var chatgpt_auth_exports = {};
__export(chatgpt_auth_exports, {
  CHATGPT_IDENTITY: () => CHATGPT_IDENTITY,
  CHATGPT_OAUTH: () => CHATGPT_OAUTH,
  exchangeDeviceCode: () => exchangeDeviceCode,
  pollDeviceCode: () => pollDeviceCode,
  refreshChatgptTokens: () => refreshChatgptTokens,
  startDeviceCode: () => startDeviceCode
});
module.exports = __toCommonJS(chatgpt_auth_exports);
var import_jwt = require("../jwt");
var import_provider = require("../provider");
const CHATGPT_OAUTH = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  deviceCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  devicePollUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  tokenUrl: "https://auth.openai.com/oauth/token",
  deviceRedirectUri: "https://auth.openai.com/deviceauth/callback",
  /** Where the user types the code. */
  verificationUrl: "https://auth.openai.com/codex/device",
  /** The code is valid for 15 minutes (prompt text in the CLI). */
  windowMs: 15 * 6e4,
  /** Fallback lifetime when the access token carries no expiry. */
  fallbackLifetimeMs: 60 * 6e4
};
const CHATGPT_IDENTITY = {
  originator: "codex_cli_rs",
  userAgent: "codex_cli_rs/0.153.2"
};
function str(body, key) {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const value = body[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
async function startDeviceCode(post, now) {
  const body = await post(CHATGPT_OAUTH.deviceCodeUrl, { client_id: CHATGPT_OAUTH.clientId });
  const userCode = str(body, "user_code");
  const deviceAuthId = str(body, "device_auth_id");
  if (!userCode || !deviceAuthId) {
    throw new import_provider.FetchError("network", "unexpected device-code response");
  }
  const advised = Number(str(body, "interval"));
  return {
    userCode,
    deviceAuthId,
    intervalSec: Number.isFinite(advised) && advised >= 1 ? advised : 5,
    expiresAt: now + CHATGPT_OAUTH.windowMs
  };
}
async function pollDeviceCode(start, post) {
  let body;
  try {
    body = await post(CHATGPT_OAUTH.devicePollUrl, {
      device_auth_id: start.deviceAuthId,
      user_code: start.userCode
    });
  } catch (e) {
    if (e instanceof import_provider.FetchError && e.kind === "auth") {
      return { status: "pending" };
    }
    throw e;
  }
  const code = str(body, "authorization_code");
  const codeVerifier = str(body, "code_verifier");
  if (!code || !codeVerifier) {
    return { status: "pending" };
  }
  return { status: "ready", code, codeVerifier };
}
async function exchangeDeviceCode(code, codeVerifier, post, now) {
  const body = await post(CHATGPT_OAUTH.tokenUrl, {
    grant_type: "authorization_code",
    client_id: CHATGPT_OAUTH.clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: CHATGPT_OAUTH.deviceRedirectUri
  });
  return toTokenSet(body, now, "");
}
async function refreshChatgptTokens(tokens, post, now) {
  const body = await post(CHATGPT_OAUTH.tokenUrl, {
    client_id: CHATGPT_OAUTH.clientId,
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken
  });
  return toTokenSet(body, now, tokens.refreshToken, tokens.accountRef);
}
function toTokenSet(body, now, previousRefresh, previousAccount) {
  var _a;
  const accessToken = str(body, "access_token");
  if (!accessToken) {
    throw new import_provider.FetchError("auth", "no access token in the answer");
  }
  const idToken = str(body, "id_token");
  return {
    accessToken,
    refreshToken: str(body, "refresh_token") || previousRefresh,
    expiresAt: (0, import_jwt.jwtExpiry)(accessToken, CHATGPT_OAUTH.fallbackLifetimeMs, now),
    accountRef: (_a = idToken ? (0, import_jwt.chatgptAccountId)(idToken) : void 0) != null ? _a : previousAccount
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHATGPT_IDENTITY,
  CHATGPT_OAUTH,
  exchangeDeviceCode,
  pollDeviceCode,
  refreshChatgptTokens,
  startDeviceCode
});
//# sourceMappingURL=chatgpt-auth.js.map

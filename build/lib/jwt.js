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
var jwt_exports = {};
__export(jwt_exports, {
  chatgptAccountId: () => chatgptAccountId,
  jwtClaims: () => jwtClaims,
  jwtExpiry: () => jwtExpiry
});
module.exports = __toCommonJS(jwt_exports);
function jwtClaims(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
function jwtExpiry(token, fallbackMs, now) {
  var _a;
  const exp = (_a = jwtClaims(token)) == null ? void 0 : _a.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1e3 : now + fallbackMs;
}
function chatgptAccountId(idToken) {
  var _a;
  const auth = (_a = jwtClaims(idToken)) == null ? void 0 : _a["https://api.openai.com/auth"];
  if (typeof auth !== "object" || auth === null) {
    return void 0;
  }
  const value = auth.chatgpt_account_id;
  return typeof value === "string" && value ? value : void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  chatgptAccountId,
  jwtClaims,
  jwtExpiry
});
//# sourceMappingURL=jwt.js.map

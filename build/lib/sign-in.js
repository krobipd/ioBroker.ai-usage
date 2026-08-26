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
var sign_in_exports = {};
__export(sign_in_exports, {
  SIGN_IN_FLOWS: () => SIGN_IN_FLOWS,
  attemptExpired: () => attemptExpired
});
module.exports = __toCommonJS(sign_in_exports);
const SIGN_IN_FLOWS = {
  "claude-sub": "paste-code",
  "chatgpt-sub": "device-code",
  "gemini-sub": "paste-url"
};
function attemptExpired(expiresAt, now) {
  return now >= expiresAt;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SIGN_IN_FLOWS,
  attemptExpired
});
//# sourceMappingURL=sign-in.js.map

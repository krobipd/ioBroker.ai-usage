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
var i18n_exports = {};
__export(i18n_exports, {
  clearCatalogue: () => clearCatalogue,
  loadCatalogue: () => loadCatalogue,
  tName: () => tName
});
module.exports = __toCommonJS(i18n_exports);
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
let words = {};
function loadCatalogue(rootDir) {
  var _a;
  const dir = (0, import_node_path.join)(rootDir, "i18n");
  const loaded = {};
  for (const file of (0, import_node_fs.readdirSync)(dir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const lang = file.slice(0, -".json".length);
    const texts = JSON.parse((0, import_node_fs.readFileSync)((0, import_node_path.join)(dir, file), "utf8"));
    for (const [key, text] of Object.entries(texts)) {
      if (typeof text !== "string") {
        continue;
      }
      (_a = loaded[key]) != null ? _a : loaded[key] = {};
      loaded[key][lang] = text;
    }
  }
  words = loaded;
  return Object.keys(words).length;
}
function clearCatalogue() {
  words = {};
}
function tName(key, arg) {
  const entry = words[key];
  if (!entry) {
    return arg === void 0 ? key : key.replace("%s", argIn(arg, "en"));
  }
  if (arg === void 0) {
    return { ...entry };
  }
  const filled = {};
  for (const [lang, text] of Object.entries(entry)) {
    filled[lang] = text.replace("%s", argIn(arg, lang));
  }
  return filled;
}
function argIn(arg, lang) {
  var _a, _b, _c;
  if (typeof arg === "string") {
    return arg;
  }
  const table = arg;
  return (_c = (_b = (_a = table[lang]) != null ? _a : table.en) != null ? _b : Object.values(table)[0]) != null ? _c : "";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  clearCatalogue,
  loadCatalogue,
  tName
});
//# sourceMappingURL=i18n.js.map

"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  AiUsageAdapter: () => AiUsageAdapter
});
module.exports = __toCommonJS(main_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_pure_helpers = require("./lib/pure-helpers");
class AiUsageAdapter extends utils.Adapter {
  /** The validated, enabled accounts from the admin table. */
  accounts = [];
  /** Per-account poll timers (cleared synchronously in onUnload). */
  pollTimers = [];
  /**
   * @param options the adapter options
   */
  constructor(options = {}) {
    super({ ...options, name: "ai-usage" });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /** Validate the configuration and start one poll cycle per account. */
  async onReady() {
    try {
      this.accounts = (0, import_pure_helpers.parseAccounts)(this.config.accounts);
      const interval = (0, import_pure_helpers.clampPollInterval)(this.config.pollInterval);
      if (this.accounts.length === 0) {
        this.log.info("No AI accounts configured \u2014 add accounts in the instance settings");
      } else {
        this.log.info(`Monitoring ${this.accounts.length} AI account(s), polling every ${interval} s`);
      }
      await this.setState("info.connection", { val: false, ack: true });
    } catch (e) {
      this.log.error(`Startup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /**
   * Tear down synchronously — no async/await here, else the controller kills the
   * process before cleanup finishes.
   *
   * @param callback invoked when cleanup is done
   */
  onUnload(callback) {
    try {
      for (const timer of this.pollTimers) {
        this.clearInterval(timer);
      }
      this.pollTimers.length = 0;
      void this.setState("info.connection", { val: false, ack: true });
    } catch {
    }
    callback();
  }
}
if (require.main !== module) {
  module.exports = (options) => new AiUsageAdapter(options);
} else {
  (() => new AiUsageAdapter())();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AiUsageAdapter
});
//# sourceMappingURL=main.js.map

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
var import_adapter_core = require("@iobroker/adapter-core");
var import_poll_engine = require("./lib/poll-engine");
var import_pure_helpers = require("./lib/pure-helpers");
var import_deepseek = require("./lib/providers/deepseek");
var import_openrouter = require("./lib/providers/openrouter");
class AiUsageAdapter extends utils.Adapter {
  engine = null;
  /**
   * @param options the adapter options
   */
  constructor(options = {}) {
    super({ ...options, name: "ai-usage" });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /** Validate the configuration, clean up stale account trees and start the engine. */
  async onReady() {
    try {
      const accounts = (0, import_pure_helpers.parseAccounts)(this.config.accounts);
      const interval = (0, import_pure_helpers.clampPollInterval)(this.config.pollInterval);
      await this.cleanupStaleAccounts();
      if (accounts.length === 0) {
        this.log.info("No AI accounts configured \u2014 add accounts in the instance settings");
        await this.setState("info.connection", { val: false, ack: true });
        return;
      }
      const providers = /* @__PURE__ */ new Map();
      for (const account of accounts) {
        const provider = await this.makeProvider(account);
        if (provider) {
          providers.set(account.id, provider);
        }
      }
      this.engine = new import_poll_engine.PollEngine(accounts, providers, interval, {
        upsertObject: async (def) => {
          await this.extendObject(def.id, { type: def.type, common: def.common, native: {} });
        },
        setState: (id, value) => {
          void this.setState(id, { val: value, ack: true }).catch(() => {
          });
        },
        schedule: (cb, ms) => ({ kind: "interval", handle: this.setInterval(cb, ms) }),
        scheduleOnce: (cb, ms) => ({ kind: "timeout", handle: this.setTimeout(cb, ms) }),
        cancel: (handle) => {
          const timer = handle;
          if (timer.kind === "interval") {
            this.clearInterval(timer.handle);
          } else {
            this.clearTimeout(timer.handle);
          }
        },
        now: () => Date.now(),
        log: {
          debug: (m) => this.log.debug(m),
          info: (m) => this.log.info(m),
          warn: (m) => this.log.warn(m),
          error: (m) => this.log.error(m)
        }
      });
      await this.engine.start();
      this.log.info(`Monitoring ${providers.size} of ${accounts.length} AI account(s), polling every ${interval} s`);
    } catch (e) {
      this.log.error(`Startup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /**
   * Build the provider for one account, resolving its credential from the central
   * storage. Accounts whose provider is not implemented yet, or whose credential
   * cannot be read, are skipped (the engine logs the skip).
   *
   * @param account the validated account config
   * @returns the provider, or undefined to skip the account
   */
  async makeProvider(account) {
    switch (account.provider) {
      case "openrouter": {
        const key = await this.resolveKey(account);
        return key ? (0, import_openrouter.openRouterProvider)(key) : void 0;
      }
      case "deepseek": {
        const key = await this.resolveKey(account);
        return key ? (0, import_deepseek.deepSeekProvider)(key) : void 0;
      }
      default:
        return void 0;
    }
  }
  /**
   * Read and decrypt a key-form credential from the central credential storage.
   *
   * @param account the account whose credential to resolve
   * @returns the key, or undefined (with a log line) when it cannot be read
   */
  async resolveKey(account) {
    if (!account.credentialId) {
      this.log.warn(`${account.name}: no credential selected \u2014 pick one in the instance settings`);
      return void 0;
    }
    try {
      const credential = await import_adapter_core.Credentials.getCredentials(this, account.credentialId);
      const values = credential.values;
      const key = typeof values.key === "string" && values.key ? values.key : void 0;
      if (!key) {
        this.log.warn(`${account.name}: credential ${account.credentialId} carries no API key`);
      }
      return key;
    } catch (e) {
      this.log.warn(
        `${account.name}: cannot read credential ${account.credentialId} (${e instanceof Error ? e.message : String(e)})`
      );
      return void 0;
    }
  }
  /**
   * Delete the object trees of accounts that are no longer in the table. Disabled
   * rows keep their tree (they are only paused); an EMPTY table deletes nothing —
   * the guard against wiping everything through an accidental clear.
   */
  async cleanupStaleAccounts() {
    const keepIds = (0, import_pure_helpers.validAccountIds)(this.config.accounts);
    if (keepIds.length === 0) {
      return;
    }
    const keep = /* @__PURE__ */ new Set([...keepIds, "info", "total"]);
    try {
      const objects = await this.getAdapterObjectsAsync();
      const roots = /* @__PURE__ */ new Set();
      for (const id of Object.keys(objects)) {
        const relative = id.substring(this.namespace.length + 1);
        const root = relative.split(".")[0];
        if (root && !keep.has(root)) {
          roots.add(root);
        }
      }
      for (const root of roots) {
        this.log.info(`Removing objects of no longer configured account "${root}"`);
        await this.delObjectAsync(root, { recursive: true });
      }
    } catch (e) {
      this.log.warn(`Cleanup of stale accounts failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /**
   * Tear down synchronously — no async/await here, else the controller kills the
   * process before cleanup finishes.
   *
   * @param callback invoked when cleanup is done
   */
  onUnload(callback) {
    var _a;
    try {
      (_a = this.engine) == null ? void 0 : _a.stop();
      this.engine = null;
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

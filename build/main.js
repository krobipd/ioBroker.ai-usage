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
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var import_http = require("./lib/http");
var import_poll_engine = require("./lib/poll-engine");
var import_pure_helpers = require("./lib/pure-helpers");
var import_claude_auth = require("./lib/providers/claude-auth");
var import_anthropic_api = require("./lib/providers/anthropic-api");
var import_claude_sub = require("./lib/providers/claude-sub");
var import_copilot = require("./lib/providers/copilot");
var import_deepseek = require("./lib/providers/deepseek");
var import_openai = require("./lib/providers/openai");
var import_openrouter = require("./lib/providers/openrouter");
class AiUsageAdapter extends utils.Adapter {
  engine = null;
  /** Pending Claude sign-in attempts, keyed by account id (PKCE lives only in memory). */
  pendingClaudeAuth = /* @__PURE__ */ new Map();
  /**
   * @param options the adapter options
   */
  constructor(options = {}) {
    super({ ...options, name: "ai-usage" });
    this.on("ready", this.onReady.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Handle admin messages — the guided Claude subscription sign-in.
   *
   * @param obj the message
   */
  async onMessage(obj) {
    var _a;
    try {
      switch (obj.command) {
        case "claudeAuthStart": {
          const accountId = this.claudeAccountIdFrom(obj.message);
          if (!accountId) {
            this.respond(obj, "\u2192 Enter the exact name of a Claude subscription row from the table above");
            return;
          }
          const pkce = (0, import_claude_auth.generatePkce)();
          this.pendingClaudeAuth.set(accountId, pkce);
          this.respond(obj, (0, import_claude_auth.buildAuthorizeUrl)(pkce));
          return;
        }
        case "claudeAuthCode": {
          const accountId = this.claudeAccountIdFrom(obj.message);
          const code = typeof ((_a = obj.message) == null ? void 0 : _a.code) === "string" ? obj.message.code : "";
          const pkce = accountId ? this.pendingClaudeAuth.get(accountId) : void 0;
          if (!accountId || !pkce) {
            this.respond(obj, { error: "Generate the sign-in link first (step 1)" });
            return;
          }
          if (!code.trim()) {
            this.respond(obj, { error: "Paste the code from the Anthropic page first" });
            return;
          }
          try {
            const tokens = await (0, import_claude_auth.exchangeCode)(code, pkce, import_http.postJson, Date.now());
            await this.claudeTokenStore(accountId).save(tokens);
            this.pendingClaudeAuth.delete(accountId);
            this.respond(obj, { result: "Signed in \u2014 restart the instance (or save the settings) to start polling" });
          } catch (e) {
            this.respond(obj, { error: `Sign-in failed: ${e instanceof Error ? e.message : String(e)}` });
          }
          return;
        }
        default:
          this.respond(obj, { error: `Unknown command: ${obj.command}` });
      }
    } catch (e) {
      this.log.error(`onMessage failed: ${e instanceof Error ? e.message : String(e)}`);
      this.respond(obj, { error: "internal error \u2014 see log" });
    }
  }
  /**
   * Send a message response, when the caller expects one.
   *
   * @param obj the request message
   * @param response the response payload
   */
  respond(obj, response) {
    if (obj.callback) {
      this.sendTo(obj.from, obj.command, response, obj.callback);
    }
  }
  /**
   * Resolve the account id for a Claude sign-in message: the given name must match
   * a claude-sub row of the accounts table.
   *
   * @param message the message payload ({ account })
   * @returns the id-safe account id, or undefined
   */
  claudeAccountIdFrom(message) {
    const name = typeof (message == null ? void 0 : message.account) === "string" ? message.account : "";
    const id = (0, import_pure_helpers.sanitizeId)(name);
    if (!id) {
      return void 0;
    }
    const accounts = (0, import_pure_helpers.parseAccounts)(this.config.accounts);
    return accounts.some((account) => account.id === id && account.provider === "claude-sub") ? id : void 0;
  }
  /**
   * The persistent token storage for one Claude account: an encrypted JSON file in
   * the instance data directory (a `native` write would restart the instance).
   *
   * @param accountId the id-safe account id
   * @returns the store
   */
  claudeTokenStore(accountId) {
    const dir = utils.getAbsoluteInstanceDataDir(this);
    const file = (0, import_node_path.join)(dir, `claude-tokens-${accountId}.json`);
    return {
      load: async () => {
        try {
          const encrypted = await (0, import_promises.readFile)(file, "utf8");
          const parsed = JSON.parse(this.decrypt(encrypted));
          if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") {
            return null;
          }
          return {
            accessToken: parsed.accessToken,
            refreshToken: parsed.refreshToken,
            expiresAt: Number(parsed.expiresAt) || 0
          };
        } catch {
          return null;
        }
      },
      save: async (tokens) => {
        await (0, import_promises.mkdir)(dir, { recursive: true });
        await (0, import_promises.writeFile)(file, this.encrypt(JSON.stringify(tokens)), "utf8");
      }
    };
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
        },
        notify: this.config.notifications ? (_account, message) => void this.registerNotification("ai-usage", "userActionRequired", message).catch(
          (e) => this.log.debug(`Could not raise notification: ${e instanceof Error ? e.message : String(e)}`)
        ) : void 0
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
      case "claude-sub":
        return (0, import_claude_sub.claudeSubProvider)(this.claudeTokenStore(account.id), void 0, import_http.postJson);
      case "openrouter": {
        const key = await this.resolveKey(account);
        return key ? (0, import_openrouter.openRouterProvider)(key) : void 0;
      }
      case "deepseek": {
        const key = await this.resolveKey(account);
        return key ? (0, import_deepseek.deepSeekProvider)(key) : void 0;
      }
      case "openai": {
        const key = await this.resolveKey(account);
        return key ? (0, import_openai.openAiProvider)(key) : void 0;
      }
      case "anthropic-api": {
        const key = await this.resolveKey(account);
        return key ? (0, import_anthropic_api.anthropicApiProvider)(key) : void 0;
      }
      case "copilot": {
        const login = await this.resolveLogin(account);
        return login ? (0, import_copilot.copilotProvider)(login.user, login.token) : void 0;
      }
      default:
        return void 0;
    }
  }
  /**
   * Read and decrypt a login/password credential (Copilot: user name + access token).
   *
   * @param account the account whose credential to resolve
   * @returns user + token, or undefined (with a log line) when it cannot be read
   */
  async resolveLogin(account) {
    if (!account.credentialId) {
      this.log.warn(`${account.name}: no credential selected \u2014 pick one in the instance settings`);
      return void 0;
    }
    try {
      const credential = await import_adapter_core.Credentials.getCredentials(this, account.credentialId);
      const values = credential.values;
      const user = typeof values.login === "string" && values.login ? values.login : void 0;
      const token = typeof values.password === "string" && values.password ? values.password : void 0;
      if (!user || !token) {
        this.log.warn(
          `${account.name}: credential ${account.credentialId} needs the login & password form (user name + access token)`
        );
        return void 0;
      }
      return { user, token };
    } catch (e) {
      this.log.warn(
        `${account.name}: cannot read credential ${account.credentialId} (${e instanceof Error ? e.message : String(e)})`
      );
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

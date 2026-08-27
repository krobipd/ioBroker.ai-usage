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
var import_sign_in = require("./lib/sign-in");
var import_claude_auth = require("./lib/providers/claude-auth");
var import_claude_sub = require("./lib/providers/claude-sub");
var import_chatgpt_auth = require("./lib/providers/chatgpt-auth");
var import_chatgpt_sub = require("./lib/providers/chatgpt-sub");
var import_gemini_auth = require("./lib/providers/gemini-auth");
var import_gemini_sub = require("./lib/providers/gemini-sub");
var import_anthropic_api = require("./lib/providers/anthropic-api");
var import_deepseek = require("./lib/providers/deepseek");
var import_openai = require("./lib/providers/openai");
var import_openrouter = require("./lib/providers/openrouter");
class AiUsageAdapter extends utils.Adapter {
  engine = null;
  /** Running sign-in attempts, keyed by provider kind. */
  attempts = /* @__PURE__ */ new Map();
  /** Last failure reason per provider, shown in the admin row. */
  signInErrors = /* @__PURE__ */ new Map();
  /** Device-code pollers, so they can be stopped on unload. */
  devicePollers = /* @__PURE__ */ new Map();
  /** One token store per subscription — see {@link tokenStore} for why it is shared. */
  tokenStores = /* @__PURE__ */ new Map();
  /**
   * Every state id that already existed when this process started.
   *
   * The create path runs `extendObject` for every state once per process — also for
   * states that were already in the database — so "the create path touched it" would
   * report every datapoint as new after each restart. Only what is missing from this
   * snapshot is a real addition (beszel pattern).
   */
  knownStateIds = /* @__PURE__ */ new Set();
  /** Datapoints created since the snapshot. */
  createdStates = 0;
  /** Datapoints removed since the snapshot — excluding the one-shot migration, which reports itself. */
  removedStates = 0;
  /** Whether the startup balance was already logged. */
  balanceLogged = false;
  /**
   * Read every existing state id once, before anything creates or deletes.
   *
   * @returns nothing; fills {@link knownStateIds}
   */
  async snapshotExistingStates() {
    var _a;
    try {
      const view = await this.getObjectViewAsync("system", "state", {
        startkey: `${this.namespace}.`,
        endkey: `${this.namespace}.\uFFFF`
      });
      for (const row of (_a = view == null ? void 0 : view.rows) != null ? _a : []) {
        this.knownStateIds.add(row.id.substring(this.namespace.length + 1));
      }
    } catch (e) {
      this.log.debug(`Could not snapshot existing states: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /**
   * Report what the object tree gained and lost in this startup — one line, both
   * sides, silent when nothing changed. A normal restart must stay quiet.
   */
  logDatapointBalance() {
    if (this.balanceLogged) {
      return;
    }
    this.balanceLogged = true;
    const line = (0, import_pure_helpers.datapointBalanceLine)(this.createdStates, this.removedStates);
    if (line) {
      this.log.info(line);
    }
  }
  /**
   * @param options the adapter options
   */
  constructor(options = {}) {
    super({ ...options, name: "ai-usage" });
    this.on("ready", this.onReady.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  // ---------------------------------------------------------------- sign-in
  /**
   * Handle admin messages: the three sign-in flows plus their status.
   *
   * @param obj the message
   */
  async onMessage(obj) {
    try {
      const provider = this.providerFrom(obj.message);
      switch (obj.command) {
        case "signInStart":
          this.respond(obj, provider ? await this.startSignIn(provider) : { error: "unknown provider" });
          return;
        case "signInSubmit":
          this.respond(obj, provider ? await this.submitSignIn(provider, obj.message) : { error: "unknown provider" });
          return;
        case "signInStatus":
          this.respond(obj, provider ? await this.signInState(provider) : { error: "unknown provider" });
          return;
        case "signOut":
          this.respond(obj, provider ? await this.signOut(provider) : { error: "unknown provider" });
          return;
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
   * The provider kind named in a message, if it is a subscription we know.
   *
   * @param message the message payload ({ provider })
   * @returns the provider kind, or undefined
   */
  providerFrom(message) {
    const value = typeof (message == null ? void 0 : message.provider) === "string" ? message.provider : "";
    return import_sign_in.SIGN_IN_FLOWS[value] ? value : void 0;
  }
  /**
   * Begin a sign-in: build the link (Claude/Google) or fetch a device code (ChatGPT).
   *
   * @param provider the subscription kind
   * @returns what the admin panel has to show
   */
  async startSignIn(provider) {
    this.signInErrors.delete(provider);
    this.stopDevicePoller(provider);
    const flow = import_sign_in.SIGN_IN_FLOWS[provider];
    const now = Date.now();
    try {
      if (flow === "paste-code") {
        const pkce = (0, import_claude_auth.generatePkce)();
        const url = (0, import_claude_auth.buildAuthorizeUrl)(pkce);
        this.attempts.set(provider, { flow, pkce, url, expiresAt: now + 15 * 6e4 });
        return { status: "awaiting-paste", url, flow };
      }
      if (flow === "paste-url") {
        const pkce = (0, import_gemini_auth.generateGeminiPkce)();
        const url = (0, import_gemini_auth.buildGeminiAuthorizeUrl)(pkce);
        this.attempts.set(provider, { flow, pkce, url, expiresAt: now + 15 * 6e4 });
        return { status: "awaiting-paste", url, flow };
      }
      const start = await (0, import_chatgpt_auth.startDeviceCode)(import_http.postJson, now);
      this.attempts.set(provider, { flow: "device-code", start });
      this.armDevicePoller(provider, start);
      return {
        status: "awaiting-device",
        userCode: start.userCode,
        verificationUrl: import_chatgpt_auth.CHATGPT_OAUTH.verificationUrl,
        expiresAt: start.expiresAt
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.signInErrors.set(provider, reason);
      return { status: "failed", reason };
    }
  }
  /**
   * Finish a paste-based sign-in (Claude code, Google address).
   *
   * @param provider the subscription kind
   * @param message the message payload ({ value })
   * @returns the resulting state
   */
  async submitSignIn(provider, message) {
    const attempt = this.attempts.get(provider);
    const value = typeof (message == null ? void 0 : message.value) === "string" ? message.value.trim() : "";
    if (!attempt || attempt.flow === "device-code") {
      return { status: "failed", reason: "start the sign-in first" };
    }
    if ((0, import_sign_in.attemptExpired)(attempt.expiresAt, Date.now())) {
      this.attempts.delete(provider);
      return { status: "failed", reason: "the sign-in window expired \u2014 start the sign-in again" };
    }
    if (!value) {
      return { status: "failed", reason: "nothing pasted" };
    }
    try {
      const now = Date.now();
      const tokens = attempt.flow === "paste-code" ? await (0, import_claude_auth.exchangeCode)(value, attempt.pkce, import_http.postJson, now) : await (0, import_gemini_auth.exchangeGeminiCode)((0, import_gemini_auth.extractGeminiCode)(value, attempt.pkce.state), attempt.pkce, import_http.postForm, now);
      await this.finishSignIn(provider, tokens);
      return { status: "signed-in" };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.signInErrors.set(provider, reason);
      return { status: "failed", reason };
    }
  }
  /**
   * Store fresh tokens, mark the account signed in and poll it right away — waiting
   * up to a full interval after a successful sign-in reads as "it did not work".
   *
   * @param provider the subscription kind
   * @param tokens the token set
   */
  async finishSignIn(provider, tokens) {
    var _a, _b;
    await this.tokenStore(provider).save(tokens);
    this.attempts.delete(provider);
    this.signInErrors.delete(provider);
    this.stopDevicePoller(provider);
    const id = import_pure_helpers.SUBSCRIPTION_IDS[provider];
    if (id) {
      void ((_a = this.engine) == null ? void 0 : _a.pollNow(id).catch((e) => {
        this.log.debug(`First query after sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
      }));
    }
    this.log.info(`${(_b = import_sign_in.SIGN_IN_LABELS[provider]) != null ? _b : provider}: signed in`);
  }
  /**
   * Poll the device-code endpoint until the user confirmed, the window closed or
   * the adapter stops. The handle lives in memory only — a restart mid-flow just
   * means the user starts again, which is cheaper than persisting a 15-minute secret.
   *
   * @param provider the subscription kind
   * @param start the device-code handle
   */
  armDevicePoller(provider, start) {
    const tick = async () => {
      try {
        if ((0, import_sign_in.attemptExpired)(start.expiresAt, Date.now())) {
          this.stopDevicePoller(provider);
          this.attempts.delete(provider);
          this.signInErrors.set(provider, "the code expired \u2014 start the sign-in again");
          return;
        }
        const result = await (0, import_chatgpt_auth.pollDeviceCode)(start, import_http.postJson);
        if (result.status === "ready") {
          this.stopDevicePoller(provider);
          const tokens = await (0, import_chatgpt_auth.exchangeDeviceCode)(result.code, result.codeVerifier, import_http.postForm, Date.now());
          await this.finishSignIn(provider, tokens);
        }
      } catch (e) {
        this.stopDevicePoller(provider);
        this.attempts.delete(provider);
        this.signInErrors.set(provider, e instanceof Error ? e.message : String(e));
      }
    };
    this.devicePollers.set(provider, {
      kind: "interval",
      handle: this.setInterval(() => void tick(), Math.max(start.intervalSec, 1) * 1e3)
    });
  }
  /**
   * Stop a running device-code poller.
   *
   * @param provider the subscription kind
   */
  stopDevicePoller(provider) {
    const handle = this.devicePollers.get(provider);
    if ((handle == null ? void 0 : handle.kind) === "interval") {
      this.clearInterval(handle.handle);
    }
    this.devicePollers.delete(provider);
  }
  /**
   * The current sign-in state of one subscription, for the admin row.
   *
   * @param provider the subscription kind
   * @returns the state
   */
  async signInState(provider) {
    const failure = this.signInErrors.get(provider);
    const attempt = this.attempts.get(provider);
    if ((attempt == null ? void 0 : attempt.flow) === "device-code") {
      return {
        status: "awaiting-device",
        userCode: attempt.start.userCode,
        verificationUrl: import_chatgpt_auth.CHATGPT_OAUTH.verificationUrl,
        expiresAt: attempt.start.expiresAt
      };
    }
    if (attempt) {
      if ((0, import_sign_in.attemptExpired)(attempt.expiresAt, Date.now())) {
        this.attempts.delete(provider);
        return { status: "failed", reason: "the sign-in window expired \u2014 start the sign-in again" };
      }
      return { status: "awaiting-paste", url: attempt.url, flow: attempt.flow };
    }
    if (failure) {
      return { status: "failed", reason: failure };
    }
    return await this.tokenStore(provider).load() ? { status: "signed-in" } : { status: "signed-out" };
  }
  /**
   * Forget the tokens of one subscription.
   *
   * @param provider the subscription kind
   * @returns the resulting state
   */
  async signOut(provider) {
    await this.tokenStore(provider).clear();
    this.attempts.delete(provider);
    this.signInErrors.delete(provider);
    this.stopDevicePoller(provider);
    return { status: "signed-out" };
  }
  // ------------------------------------------------------------ token files
  /**
   * The token store of one subscription — created ONCE per provider.
   *
   * The identity matters: the store holds the in-memory copy of the tokens, so
   * signing out really takes effect. When each provider module kept its own copy,
   * a sign-out deleted the file while the adapter kept polling with what it still
   * had — and the next token refresh wrote the deleted file back.
   *
   * @param provider the subscription kind
   * @returns the store
   */
  tokenStore(provider) {
    let store = this.tokenStores.get(provider);
    if (!store) {
      store = this.makeTokenStore(provider);
      this.tokenStores.set(provider, store);
    }
    return store;
  }
  /**
   * Build the store for one subscription: an encrypted file in the instance data
   * directory, named after the PROVIDER. Keying by provider (not by account name)
   * keeps a sign-in alive when an account is renamed — the previous scheme lost it.
   *
   * @param provider the subscription kind
   * @returns the store
   */
  makeTokenStore(provider) {
    const dir = utils.getAbsoluteInstanceDataDir(this);
    const file = (0, import_node_path.join)(dir, `tokens-${provider}.json`);
    let cached = null;
    let read = false;
    return {
      load: async () => {
        if (!read) {
          cached = await this.readTokenFile(file, provider);
          read = true;
        }
        return cached;
      },
      save: async (tokens) => {
        await (0, import_promises.mkdir)(dir, { recursive: true });
        await (0, import_promises.writeFile)(file, this.encrypt(JSON.stringify(tokens)), "utf8");
        cached = tokens;
        read = true;
      },
      clear: async () => {
        cached = null;
        read = true;
        await (0, import_promises.unlink)(file).catch(() => {
        });
      }
    };
  }
  /**
   * Read one token file.
   *
   * A missing file means "never signed in" and is silent. A file that is there but
   * cannot be read — damaged, or encrypted with a different instance secret — is
   * NOT the same thing: without a word in the log, signing in would look like it
   * simply does nothing.
   *
   * @param file the file path
   * @param provider the subscription kind (for the log line)
   * @returns the tokens, or null
   */
  async readTokenFile(file, provider) {
    var _a, _b;
    let raw;
    try {
      raw = await (0, import_promises.readFile)(file, "utf8");
    } catch (e) {
      if ((e == null ? void 0 : e.code) !== "ENOENT") {
        this.log.warn(`${(_a = import_sign_in.SIGN_IN_LABELS[provider]) != null ? _a : provider}: cannot open the stored sign-in (${String(e)})`);
      }
      return null;
    }
    try {
      const parsed = JSON.parse(this.decrypt(raw));
      if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") {
        throw new Error("the file carries no tokens");
      }
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: Number(parsed.expiresAt) || 0,
        accountRef: typeof parsed.accountRef === "string" ? parsed.accountRef : void 0
      };
    } catch (e) {
      this.log.warn(
        `${(_b = import_sign_in.SIGN_IN_LABELS[provider]) != null ? _b : provider}: the stored sign-in cannot be read (${e instanceof Error ? e.message : String(e)}) \u2014 sign in again in the instance settings`
      );
      return null;
    }
  }
  /**
   * Carry a sign-in from the pre-0.3.0 layout over: tokens used to be stored per
   * ACCOUNT NAME (`claude-tokens-<name>.json`). Without this the rename to fixed
   * account ids would silently sign the user out.
   */
  async migrateTokenFiles() {
    const dir = utils.getAbsoluteInstanceDataDir(this);
    const target = (0, import_node_path.join)(dir, "tokens-claude-sub.json");
    try {
      await (0, import_promises.readFile)(target, "utf8");
      return;
    } catch {
    }
    for (const legacy of ["claude-tokens-Claude.json", "claude-tokens-claude.json"]) {
      try {
        await (0, import_promises.rename)((0, import_node_path.join)(dir, legacy), target);
        this.log.info("Carried the existing Claude sign-in over to the new layout");
        return;
      } catch {
      }
    }
  }
  // ------------------------------------------------------------- life cycle
  /** Validate the configuration, clean up stale objects and start the engine. */
  async onReady() {
    try {
      const accounts = (0, import_pure_helpers.parseAccounts)(this.config.accounts);
      const interval = (0, import_pure_helpers.clampPollInterval)(this.config.pollInterval);
      await this.migrateTokenFiles();
      await this.snapshotExistingStates();
      await this.cleanupStaleObjects();
      const retired = await this.removeRetiredStates(accounts);
      if (retired > 0) {
        this.log.info(`Object tree updated: removed ${retired} obsolete status datapoint(s)`);
      }
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
          if (def.type === "state" && !this.knownStateIds.has(def.id)) {
            this.knownStateIds.add(def.id);
            this.createdStates++;
          }
        },
        setState: (id, value) => {
          void this.setState(id, { val: value, ack: true }).catch(() => {
          });
        },
        setStateChanged: (id, value) => {
          void this.setStateChangedAsync(id, { val: value, ack: true }).catch(() => {
          });
        },
        deleteObject: async (id) => {
          try {
            await this.delObjectAsync(id, { recursive: true });
            if (this.knownStateIds.delete(id)) {
              this.removedStates++;
            }
          } catch (e) {
            this.log.debug(`Could not remove ${id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
        listStateIds: async (prefix) => {
          var _a;
          const start = `${this.namespace}.${prefix}.`;
          const view = await this.getObjectViewAsync("system", "state", {
            startkey: start,
            endkey: `${start}\uFFFF`
          });
          return ((_a = view == null ? void 0 : view.rows) != null ? _a : []).map((row) => row.id.substring(this.namespace.length + 1));
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
        afterFirstRound: () => this.logDatapointBalance(),
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
   * Build the provider for one account.
   *
   * @param account the validated account config
   * @returns the provider, or undefined to skip the account
   */
  async makeProvider(account) {
    switch (account.provider) {
      case "claude-sub":
        return (0, import_claude_sub.claudeSubProvider)(this.tokenStore(account.provider), import_http.postJson);
      case "chatgpt-sub":
        return (0, import_chatgpt_sub.chatgptSubProvider)(this.tokenStore(account.provider), import_http.postJson);
      case "gemini-sub":
        return (0, import_gemini_sub.geminiSubProvider)(this.tokenStore(account.provider), import_http.postJson, import_http.postForm);
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
   * Status states retired in 0.5.0 — `provider` (visible in the node name anyway),
   * `reachable`/`serviceOnline`/`state` (three spellings of one fact) and `signedIn`
   * (the settings page asks the adapter directly).
   *
   * ioBroker never garbage-collects an object whose id the adapter stopped writing:
   * it would sit there frozen on its last value and keep lying. So the old ids are
   * deleted from a fixed list — no state reading, no heuristics.
   */
  static RETIRED_INFO_STATES = [
    "info.provider",
    "info.reachable",
    "info.serviceOnline",
    "info.state",
    "info.signedIn"
  ];
  /**
   * Remove the retired status states of every configured account.
   *
   * Which of them still exist is answered by the startup snapshot that was read a
   * moment earlier — asking the database for every id on every start would keep
   * costing 35 lookups forever for a migration that is done after the first one.
   *
   * @param accounts the configured accounts
   * @returns how many objects were actually deleted
   */
  async removeRetiredStates(accounts) {
    let removed = 0;
    for (const account of accounts) {
      for (const suffix of AiUsageAdapter.RETIRED_INFO_STATES) {
        const id = `${account.id}.${suffix}`;
        if (!this.knownStateIds.has(id)) {
          continue;
        }
        try {
          await this.delObjectAsync(id);
          removed++;
          this.knownStateIds.delete(id);
        } catch (e) {
          this.log.debug(`Could not remove ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return removed;
  }
  /**
   * Delete object trees that no longer belong to a configured account, plus the
   * `auth` branch of the pre-0.3.0 layout. An EMPTY table deletes nothing — the
   * guard against wiping everything through an accidental clear.
   */
  async cleanupStaleObjects() {
    const keepIds = (0, import_pure_helpers.parseAccounts)(this.config.accounts).map((account) => account.id);
    if (keepIds.length === 0) {
      return;
    }
    const keep = /* @__PURE__ */ new Set([...keepIds, "info", "total"]);
    try {
      const objects = await this.getAdapterObjectsAsync();
      const roots = /* @__PURE__ */ new Set();
      for (const id of Object.keys(objects)) {
        const root = id.substring(this.namespace.length + 1).split(".")[0];
        if (root && !keep.has(root)) {
          roots.add(root);
        }
      }
      for (const root of roots) {
        this.log.info(
          root === "auth" ? "Removing the old sign-in branch \u2014 the sign-in state now lives inside each account" : `Removing objects of no longer configured account "${root}"`
        );
        for (const id of [...this.knownStateIds]) {
          if (id === root || id.startsWith(`${root}.`)) {
            this.knownStateIds.delete(id);
            this.removedStates++;
          }
        }
        await this.delObjectAsync(root, { recursive: true });
      }
    } catch (e) {
      this.log.warn(`Cleanup of stale objects failed: ${e instanceof Error ? e.message : String(e)}`);
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
      for (const provider of [...this.devicePollers.keys()]) {
        this.stopDevicePoller(provider);
      }
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

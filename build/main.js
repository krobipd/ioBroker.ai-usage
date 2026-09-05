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
var import_i18n = require("./lib/i18n");
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
const PROVIDER_BY_ACCOUNT_ID = Object.fromEntries(
  Object.entries(import_pure_helpers.SUBSCRIPTION_IDS).map(([provider, id]) => [id, provider])
);
const SORT_KEY_END = "\uFFFF";
class AiUsageAdapter extends utils.Adapter {
  engine = null;
  /** Running sign-in attempts, keyed by provider kind. */
  attempts = /* @__PURE__ */ new Map();
  /** Last failure reason per provider, shown in the admin row. */
  signInErrors = /* @__PURE__ */ new Map();
  /**
   * Providers whose last query was rejected with `auth` — the stored tokens exist but
   * no longer work.
   *
   * Without this the settings page reads "signed in" off the mere EXISTENCE of the
   * token file: a dead refresh token left a green check next to an amber badge saying
   * "Sign-in rejected". That is the exact inverse of the bug krobi found on
   * 2026-09-01, and just as much a lie. The file is deliberately NOT deleted — a
   * provider hiccup must not silently sign the user out — the card is simply told the
   * truth so the sign-in button is there when it is needed.
   */
  rejectedTokens = /* @__PURE__ */ new Set();
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
        endkey: `${this.namespace}.${SORT_KEY_END}`
      });
      for (const row of (_a = view == null ? void 0 : view.rows) != null ? _a : []) {
        this.knownStateIds.add(row.id.substring(this.namespace.length + 1));
      }
    } catch (e) {
      this.log.debug(`Could not snapshot existing states: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /**
   * Count one state the create path just touched — but only if it is genuinely new.
   *
   * The create path runs `extendObject` for EVERY state once per process, including
   * the ones that were already in the database. "The create path touched it" would
   * therefore report the whole tree as new after every restart, and the balance line
   * would be noise within a day. Only what the startup snapshot did not hold counts.
   *
   * @param id the state id, relative to the instance
   */
  countUpsert(id) {
    if (!this.knownStateIds.has(id)) {
      this.knownStateIds.add(id);
      this.createdStates++;
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
    this.rejectedTokens.delete(provider);
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
    this.rejectedTokens.delete(provider);
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
    if (await this.tokenStore(provider).load() && !this.rejectedTokens.has(provider)) {
      this.signInErrors.delete(provider);
      return { status: "signed-in" };
    }
    if (this.rejectedTokens.has(provider)) {
      return { status: "failed", reason: failure != null ? failure : "the stored sign-in was rejected \u2014 sign in again" };
    }
    if (failure) {
      return { status: "failed", reason: failure };
    }
    return { status: "signed-out" };
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
    this.rejectedTokens.delete(provider);
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
        await (0, import_promises.writeFile)(file, this.encrypt(JSON.stringify(tokens)), { encoding: "utf8", mode: 384 });
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
  /**
   * Remove a leftover `supportedMessages` key from THIS instance's object.
   *
   * The entry lives in two places: in the adapter's manifest, and as a copy in the
   * instance object in the database. An update merges the manifest into that copy —
   * it never removes a field. So on every installation that ran a version carrying
   * the entry, the host keeps killing the process outright and `onUnload` still never
   * runs: the update alone changes nothing (found by a second pair of eyes on the
   * live server 2026-08-27, after my own test had been contaminated by a value I had
   * set by hand).
   *
   * 0.9.2 wrote `{ stopInstance: false }` here, which made it WORSE: the key is a
   * positive list, so an object without a value other than false shuts the message
   * box — the host no longer looks at `common.messagebox`, never subscribes, and no
   * `sendTo` reaches the adapter, without a single line in the log. Every sign-in
   * from the settings page went nowhere (measured on the live server 2026-09-04:
   * `supportedMessages: {"stopInstance": false}`). The key has to be DELETED, and
   * the trigger has to be its mere existence — the old guard read `stopInstance`
   * and therefore never saw the state it had written itself.
   *
   * Writing the instance object makes the host restart this instance once. That is
   * the price, it happens on the first start after the update and never again —
   * afterwards the condition below is false. public-holidays corrects its own run
   * mode the same way.
   *
   * @returns true when the correction was written and the restart is coming — the
   *   caller has to stop right there. Carrying on would arm the poll timers of a
   *   process the host is already shutting down, which the adapter's timer API
   *   refuses with a warning in the user's log (measured on the live server).
   */
  async clearStopInstanceFlag() {
    var _a;
    const id = `system.adapter.${this.namespace}`;
    try {
      const obj = await this.getForeignObjectAsync(id);
      const supported = (_a = obj == null ? void 0 : obj.common) == null ? void 0 : _a.supportedMessages;
      if (supported === void 0 || supported === null) {
        return false;
      }
      this.log.info("Correcting a leftover setting from an earlier version \u2014 this instance restarts once");
      await this.extendForeignObjectAsync(id, { common: { supportedMessages: null } });
      return true;
    } catch (e) {
      this.log.debug(`Could not check the instance object: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
  /**
   * The directory holding `i18n/<lang>.json` — `admin/`, one level above `build/`.
   */
  i18nRoot() {
    return (0, import_node_path.join)(__dirname, "..", "admin");
  }
  /**
   * Load the object-name catalogue before anything creates an object.
   *
   * A failure here must not stop the adapter — the objects would carry their keys as
   * names, which is ugly but traceable, and every value would still be correct. It
   * is loud in the log for exactly that reason.
   */
  loadTranslations() {
    try {
      const count = (0, import_i18n.loadCatalogue)(this.i18nRoot());
      this.log.debug(`Object name catalogue loaded (${count} entries)`);
    } catch (e) {
      this.log.warn(
        `Object names fall back to their keys \u2014 the translations could not be read (${e instanceof Error ? e.message : String(e)})`
      );
    }
  }
  /**
   * Objects declared in the manifest, refreshed on every start.
   *
   * js-controller applies `instanceObjects` itself, but with `preserve` on
   * `common.name`: a RENAMED object reaches new installations only, while every
   * existing tree keeps the old text and the manifest looks correct all the while.
   * The explicit refresh is what carries a changed name or description into an
   * installation that already exists (fleet rule).
   */
  async refreshManifestObjects() {
    try {
      await this.extendObject("info", {
        type: "channel",
        common: { name: (0, import_i18n.tName)("nameInfoChannel") },
        native: {}
      });
      await this.extendObject("info.connection", {
        type: "state",
        // The only one of the three with something to explain — the two containers
        // stay without a description rather than getting an invented sentence.
        common: { name: (0, import_i18n.tName)("nameConnection"), desc: (0, import_i18n.tName)("descConnection") },
        native: {}
      });
      await this.extendObject("total", {
        type: "folder",
        common: { name: (0, import_i18n.tName)("nameTotalFolder") },
        native: {}
      });
    } catch (e) {
      this.log.debug(`Could not refresh the manifest objects: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /** Validate the configuration, clean up stale objects and start the engine. */
  async onReady() {
    try {
      if (await this.clearStopInstanceFlag()) {
        return;
      }
      this.loadTranslations();
      await this.refreshManifestObjects();
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
          if (def.type === "state") {
            this.countUpsert(def.id);
          }
        },
        setState: (id, value) => {
          void this.setState(id, { val: value, ack: true }).catch(() => {
          });
        },
        setStateChanged: async (id, value) => {
          await this.setStateChangedAsync(id, { val: value, ack: true }).catch(() => {
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
            endkey: `${start}${SORT_KEY_END}`
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
        authState: (accountId, rejected) => {
          const provider = PROVIDER_BY_ACCOUNT_ID[accountId];
          if (!provider) {
            return;
          }
          if (rejected) {
            this.rejectedTokens.add(provider);
          } else {
            this.rejectedTokens.delete(provider);
          }
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
        return key ? (0, import_openai.openAiProvider)(key, import_http.getJson, Date.now, (m) => this.log.warn(`${account.name}: ${m}`)) : void 0;
      }
      case "anthropic-api": {
        const key = await this.resolveKey(account);
        return key ? (0, import_anthropic_api.anthropicApiProvider)(key, import_http.getJson, Date.now, (m) => this.log.warn(`${account.name}: ${m}`)) : void 0;
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
   * Tear down: cancel everything, then say that nothing is delivering any more.
   *
   * The final writes are AWAITED before `callback()` — measured on the live server
   * (2026-08-27), a fire-and-forget write followed by an immediate callback never
   * reached the database, so a switched-off instance kept showing every account as
   * online. The whole thing takes about 100 ms.
   *
   * Deliberately WITHOUT a time limit of its own: the adapter's timer API refuses to
   * arm once shutdown has begun, and the host already applies the only deadline that
   * matters — it ends the process a second after asking. A states database that
   * hangs would swallow the writes either way, so a second guard adds code, not
   * safety.
   *
   * None of this runs while `common.supportedMessages.stopInstance` sits in the
   * manifest: with it the host kills the process outright instead of asking, and
   * every state written here is dead code. A test pins that the entry stays out.
   *
   * @param callback invoked when cleanup is done
   */
  onUnload(callback) {
    var _a, _b;
    try {
      for (const provider of [...this.devicePollers.keys()]) {
        this.stopDevicePoller(provider);
      }
      const engine = this.engine;
      (_a = this.engine) == null ? void 0 : _a.stop();
      this.engine = null;
      void ((_b = engine == null ? void 0 : engine.markAllOffline()) != null ? _b : this.setState("info.connection", { val: false, ack: true })).then(() => this.log.debug("Shutdown: final states written")).catch((e) => this.log.debug(`Shutdown: final states rejected \u2014 ${e instanceof Error ? e.message : String(e)}`)).finally(callback);
    } catch {
      callback();
    }
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

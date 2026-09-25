import React from "react";

import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import LoginIcon from "@mui/icons-material/Login";
import LogoutIcon from "@mui/icons-material/Logout";
import SmartToyIcon from "@mui/icons-material/SmartToy";

import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from "@iobroker/json-config";
import { I18n } from "@iobroker/gui-components";

import type { SignInState } from "../../src/lib/sign-in.js";
import {
  KEY_PROVIDERS,
  SUBSCRIPTIONS,
  answerDeadline,
  credentialListState,
  mergeSignIn,
  needsSignInRefresh,
  offerForCredential,
  orphanRows,
  setThreshold,
  subscriptionRow,
  accountId,
  serviceBadge,
  toggleCredential,
  toggleSubscription,
  withDeadline,
  type AccountRow,
  type CredentialEntry,
  type PanelFacts,
} from "./rows";

/**
 * High sort-end marker for object-view key ranges — everything below the prefix.
 *
 * The same constant the adapter uses. It used to be a hand-typed `香` here, which
 * quietly hid every credential sorting above U+9999 from this list.
 */
const SORT_KEY_END = "\uFFFF";

interface PanelState extends ConfigGenericState {
  credentials: CredentialEntry[];
  credentialsLoaded: boolean;
  /** Whether reading the credential storage failed — never shown as "nothing stored". */
  credentialsFailed: boolean;
  /** What the user is typing into a threshold field, per row, until it is committed. */
  thresholdDrafts: Record<string, string>;
  /** The outcome of the last copy click, per button. */
  copied: Record<string, "ok" | "manual">;
  /** Sign-in state per subscription provider. */
  signIn: Record<string, SignInState>;
  /** What the user typed into a paste field, per provider. */
  drafts: Record<string, string>;
  /** Provider chosen manually for a credential whose name gives nothing away. */
  providerChoice: Record<string, string>;
  /** Live `info.unreach` + `info.error` per account id — drives the status badge in the row. */
  serviceState: Record<string, unknown>;
  busy: string;
}

/**
 * The whole instance configuration as ONE list of AI accounts: the three
 * subscriptions (signed in with the user's own account) and every credential of
 * the admin's central storage, each an ordinary row with an on/off switch.
 *
 * The panel owns the `accounts` native field and drives the sign-in flows over the
 * message channel; each provider gets the instructions that actually apply to it,
 * because the three flows genuinely differ.
 */
/** How often the sign-in status is asked while a device code is waiting (ms). */
const DEVICE_POLL_MS = 4000;
/** How often it is asked otherwise (ms). */
const IDLE_POLL_MS = 30000;

export default class ConfigPanel extends ConfigGeneric<ConfigGenericProps, PanelState> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The state ids this card is subscribed to, so it can unsubscribe cleanly. */
  private subscribed: string[] = [];
  /** True once the card is gone — a late answer must not call setState. */
  private unmounted = false;
  /** Raised by every user action per provider — a status answer from before it is stale. */
  private readonly sequence: Record<string, number> = {};

  constructor(props: ConfigGenericProps) {
    super(props);
    this.state = {
      ...this.state,
      credentials: [],
      credentialsLoaded: false,
      credentialsFailed: false,
      thresholdDrafts: {},
      copied: {},
      signIn: {},
      drafts: {},
      providerChoice: {},
      serviceState: {},
      busy: "",
    };
  }

  async componentDidMount(): Promise<void> {
    void super.componentDidMount?.();
    // In parallel: the subscription rows must not wait for the credential-storage
    // scan. Serialised, a slow object view kept the Claude row on its spinner for
    // the whole scan although the adapter could have answered instantly.
    await Promise.all([this.loadCredentials(), this.refreshSignIn(), this.syncSubscriptions()]);
    this.scheduleSignInPoll();
  }

  componentDidUpdate(previous: ConfigGenericProps): void {
    // Rows come and go while the user switches accounts on and off.
    void this.syncSubscriptions();
    // Started, saved, or a subscription switched on: the status is new NOW, not in
    // up to thirty seconds (decision 107).
    if (needsSignInRefresh(this.factsOf(previous), this.factsOf(this.props))) {
      void this.refreshSignIn().finally(() => this.scheduleSignInPoll());
    }
  }

  /**
   * The facts that decide whether the sign-in status must be asked again.
   *
   * @param props the props to read
   */
  private factsOf(props: ConfigGenericProps): PanelFacts {
    const rows = ConfigGeneric.getValue(props.data, "accounts") as unknown;
    const list = Array.isArray(rows) ? (rows as AccountRow[]) : [];
    return {
      alive: !!props.alive,
      changed: !!props.changed,
      subscriptions: SUBSCRIPTIONS.filter(entry => subscriptionRow(list, entry.provider)).map(entry => entry.provider),
    };
  }

  componentWillUnmount(): void {
    this.unmounted = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unsubscribeAll();
    super.componentWillUnmount?.();
  }

  /**
   * Ask the adapter for the sign-in status again — fast while a device code is
   * waiting for the user, slowly otherwise.
   *
   * The card used to ask every four seconds for everything, for as long as it was
   * open: one message per subscription plus two state reads per account, whether
   * anything had changed or not. Only the device-code flow finishes elsewhere and
   * genuinely needs a short beat; the status values arrive through a subscription
   * now and need none at all.
   */
  private scheduleSignInPoll(): void {
    if (this.unmounted) {
      return;
    }
    // Re-armed from scratch, so a beat that has just become wrong is dropped: after
    // starting the device-code flow the pending 30-second timer would otherwise run
    // out first, and the card needed up to 34 s to show "signed in" — in the one
    // flow where the user is actively waiting.
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const waiting = Object.values(this.state.signIn).some(state => state?.status === "awaiting-device");
    this.timer = setTimeout(
      () => {
        // `finally`, not `then`: a single rejection would end the chain for good and
        // the card would stop refreshing until the page is reloaded.
        void this.refreshSignIn().finally(() => this.scheduleSignInPoll());
      },
      waiting ? DEVICE_POLL_MS : IDLE_POLL_MS,
    );
  }

  /**
   * Keep the state subscriptions in step with the switched-on accounts.
   *
   * `subscribeState` hands the current value to the same callback right after
   * subscribing, so the badge is filled without a single extra read.
   */
  private async syncSubscriptions(): Promise<void> {
    const ctx = this.props.oContext;
    const wanted: string[] = [];
    for (const row of this.accounts()) {
      const id = accountId(row.provider, row.credentialId);
      if (id) {
        wanted.push(`${ctx.adapterName}.${ctx.instance}.${id}.info.unreach`);
        wanted.push(`${ctx.adapterName}.${ctx.instance}.${id}.info.error`);
      }
    }
    if (wanted.length === this.subscribed.length && wanted.every(id => this.subscribed.includes(id))) {
      return;
    }
    this.unsubscribeAll();
    this.subscribed = wanted;
    if (wanted.length === 0) {
      return;
    }
    try {
      await ctx.socket.subscribeState(wanted, this.onStateChange);
    } catch {
      // No subscription: the badges stay on whatever they last showed rather than
      // blanking out — a socket hiccup is not an account without a status.
    }
  }

  /** Drop every running subscription. */
  private unsubscribeAll(): void {
    if (this.subscribed.length > 0) {
      this.props.oContext.socket.unsubscribeState(this.subscribed, this.onStateChange);
      this.subscribed = [];
    }
  }

  /**
   * One status value arrived.
   *
   * @param id the full state id
   * @param state the new state, or null when it was deleted
   */
  private onStateChange = (id: string, state: ioBroker.State | null | undefined): void => {
    if (this.unmounted || !state || state.val === null || state.val === undefined) {
      return;
    }
    const parts = id.split(".");
    const key = `${parts[2]}.${parts[parts.length - 1]}`;
    this.setState(prev => ({ serviceState: { ...prev.serviceState, [key]: state.val } }));
  };

  /** Read the AI entries of the admin's central credential storage. */
  private async loadCredentials(): Promise<void> {
    try {
      const objects = await this.props.oContext.socket.getObjectViewSystem(
        "config",
        "system.credentials.",
        `system.credentials.${SORT_KEY_END}`,
      );
      const credentials: CredentialEntry[] = (Object.values(objects || {}) as ioBroker.Object[])
        .filter(obj => !!obj && (obj.native as { type?: string })?.type === "ai")
        .map(obj => {
          const suffix = obj._id.substring("system.credentials.".length);
          const rawName = obj.common?.name;
          const name =
            typeof rawName === "string"
              ? rawName
              : (rawName as Record<string, string>)?.en || Object.values(rawName || {})[0] || suffix;
          return {
            id: obj._id,
            suffix,
            name,
            icon: typeof obj.common?.icon === "string" ? obj.common.icon : undefined,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      this.setState({ credentials, credentialsLoaded: true, credentialsFailed: false });
    } catch {
      // A failed read is not "nothing stored" (decision 105).
      this.setState({ credentialsLoaded: true, credentialsFailed: true });
    }
  }

  /**
   * The status badge of one row, or null while the account has never reported.
   *
   * @param provider the provider kind
   * @param credentialId the credential id for key-based accounts
   */
  private renderServiceBadge(provider: string, credentialId: string): React.JSX.Element | null {
    const id = accountId(provider, credentialId);
    const badge = serviceBadge(this.state.serviceState[`${id}.unreach`], this.state.serviceState[`${id}.error`]);
    if (!badge) {
      return null;
    }
    return (
      <Chip
        size="small"
        color={badge.color}
        variant="outlined"
        label={I18n.t(badge.key)}
        title={badge.title}
      />
    );
  }

  /**
   * The account's reason in plain sight — the badge's hover title alone reached
   * neither a keyboard nor a touch screen.
   *
   * @param provider the provider kind
   * @param credentialId the credential id for key-based accounts
   */
  private renderReason(provider: string, credentialId: string): React.JSX.Element | null {
    const id = accountId(provider, credentialId);
    const badge = serviceBadge(this.state.serviceState[`${id}.unreach`], this.state.serviceState[`${id}.error`]);
    if (!badge?.title) {
      return null;
    }
    return (
      <Typography
        variant="caption"
        sx={{ display: "block", pl: 6, pb: 1, opacity: 0.8 }}
      >
        {badge.title}
      </Typography>
    );
  }

  /**
   * One switched-on key row whose stored key is gone — shown so it can be switched off.
   *
   * @param row the orphaned row
   */
  private renderOrphanRow(row: AccountRow): React.JSX.Element {
    return (
      <Box
        key={`orphan-${row.credentialId || row.name}`}
        sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 1, borderBottom: 1, borderColor: "divider" }}
      >
        <Avatar sx={{ width: 28, height: 28, bgcolor: "transparent" }}>
          <SmartToyIcon fontSize="small" />
        </Avatar>
        <Box sx={{ minWidth: 180 }}>
          <Typography>{row.name}</Typography>
          <Typography
            variant="caption"
            sx={{ color: "warning.main" }}
          >
            {I18n.t("aiu_keyMissing")}
          </Typography>
        </Box>
        <Switch
          checked
          onChange={() => this.commit(this.accounts().filter(entry => entry !== row))}
          slotProps={{ input: { "aria-label": row.name } }}
          sx={{ ml: "auto" }}
        />
      </Box>
    );
  }

  /**
   * Ask the adapter for the sign-in state of every switched-on subscription.
   *
   * A transport miss NEVER overwrites a known state: the status poll runs every
   * 4 s, and a single unanswered message (socket reconnect, busy instance) used
   * to replace a correctly shown "signed in" with the sign-in start screen —
   * a transport failure is not a sign-in status (krobi, live 2026-09-01).
   * States are merged per provider, not replaced wholesale, for the same reason.
   */
  private async refreshSignIn(): Promise<void> {
    if (!this.props.alive) {
      return;
    }
    const answers = await Promise.all(
      SUBSCRIPTIONS.filter(entry => subscriptionRow(this.accounts(), entry.provider)).map(async entry => {
        // Taken BEFORE asking: an action the user starts meanwhile raises it, and
        // this answer then describes a state that is already gone (decision 108).
        const sequence = this.sequence[entry.provider] ?? 0;
        return { provider: entry.provider, answer: await this.ask("signInStatus", entry.provider), sequence };
      }),
    );
    if (this.unmounted) {
      return;
    }
    this.setState(prev => ({ signIn: mergeSignIn(prev.signIn, answers, this.sequence) }));
  }

  /**
   * Send one sign-in message to the adapter.
   *
   * Only a REAL adapter answer comes back. No answer at all — the message timed
   * out, the socket hiccuped, the instance was busy — is `null`, and the caller
   * decides: the status poll keeps what it knows, an explicit user action shows
   * "no answer" (see {@link run}). Turning a transport miss into a "failed"
   * status here was what flipped a signed-in row onto the sign-in screen.
   *
   * @param command the message command
   * @param provider the subscription kind
   * @param value the pasted value, for signInSubmit
   * @returns the reported state, or null when the instance did not answer
   */
  private async ask(command: string, provider: string, value?: string): Promise<SignInState | null> {
    const ctx = this.props.oContext;
    try {
      // `sendTo` never gives up on its own — a lost answer used to leave the row
      // spinning until the page was reloaded (decision 106).
      const answer = await withDeadline(
        ctx.socket.sendTo(`${ctx.adapterName}.${ctx.instance}`, command, {
          provider,
          value,
        }),
        answerDeadline(command),
      );
      if (!answer) {
        return null;
      }
      if (answer.error) {
        return { status: "failed", reason: answer.error };
      }
      return answer;
    } catch {
      return null;
    }
  }

  /**
   * Run a sign-in command and show the result in the row.
   *
   * @param command the message command
   * @param provider the subscription kind
   * @param value the pasted value
   */
  private async run(command: string, provider: string, value?: string): Promise<void> {
    this.sequence[provider] = (this.sequence[provider] ?? 0) + 1;
    this.setState({ busy: provider });
    const answer = await this.ask(command, provider, value);
    if (this.unmounted) {
      return;
    }
    // Unlike the background status poll, an explicit click deserves an answer:
    // no answer at all is shown as exactly that, never silently swallowed.
    const shown: SignInState | null = answer ?? { status: "failed", reason: I18n.t("aiu_noAnswer") };
    this.setState(
      prev => ({
        busy: "",
        signIn: { ...prev.signIn, [provider]: shown },
        drafts: { ...prev.drafts, [provider]: "" },
      }),
      // The new state decides the beat — a started device-code flow has to be
      // polled every four seconds, not on the thirty-second timer still pending.
      () => this.scheduleSignInPoll(),
    );
  }

  /** The current accounts rows from the (unsaved) config data. */
  private accounts(): AccountRow[] {
    const value = ConfigGeneric.getValue(this.props.data, "accounts") as unknown;
    return Array.isArray(value) ? (value as AccountRow[]) : [];
  }

  /**
   * Commit rows into the config data (saved with the form).
   *
   * @param rows the new rows
   */
  private commit(rows: AccountRow[]): void {
    void this.onChange("accounts", rows);
  }

  /**
   * The threshold input of one switched-on row (committed on blur).
   *
   * @param key react key
   * @param row the row
   * @param match how to find the row again
   * @param match.provider
   * @param match.credentialId
   */
  private renderThreshold(
    key: string,
    row: AccountRow,
    match: { provider?: string; credentialId?: string },
  ): React.JSX.Element {
    // Controlled: after the blur the field shows what was STORED. Uncontrolled, it
    // kept showing the 5 the user typed while 10 was saved.
    const draft = this.state.thresholdDrafts[key];
    return (
      <TextField
        key={key}
        size="small"
        type="number"
        label={I18n.t("aiu_warnAt")}
        value={draft ?? String(row.warnThreshold || 80)}
        onChange={e => {
          const text = e.target.value;
          this.setState(prev => ({ thresholdDrafts: { ...prev.thresholdDrafts, [key]: text } }));
        }}
        onBlur={e => {
          const text = e.target.value;
          this.commit(setThreshold(this.accounts(), match, text));
          this.setState(prev => {
            const thresholdDrafts = { ...prev.thresholdDrafts };
            delete thresholdDrafts[key];
            return { thresholdDrafts };
          });
        }}
        slotProps={{ htmlInput: { min: 10, max: 100, style: { width: 60 } }, inputLabel: { shrink: true } }}
        sx={{ ml: "auto" }}
      />
    );
  }

  /**
   * Copy a text to the clipboard — also where the Clipboard API is missing.
   *
   * `navigator.clipboard` exists in a secure context only (HTTPS or localhost). The
   * admin runs on `http://<ip>:8081` by default, where both copy buttons silently
   * did nothing (decision 109). The fallback selects the text in a hidden field and
   * copies that; what happened is shown next to the button.
   *
   * @param key which button
   * @param text what to copy
   */
  private async copy(key: string, text: string): Promise<void> {
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        copied = true;
      } else {
        const field = document.createElement("textarea");
        field.value = text;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        copied = document.execCommand("copy");
        document.body.removeChild(field);
      }
    } catch {
      copied = false;
    }
    if (!this.unmounted) {
      this.setState(prev => ({ copied: { ...prev.copied, [key]: copied ? "ok" : "manual" } }));
    }
  }

  /**
   * What the last copy click did, next to its button.
   *
   * @param key which button
   */
  private renderCopied(key: string): React.JSX.Element | null {
    const outcome = this.state.copied[key];
    if (!outcome) {
      return null;
    }
    return (
      <Typography
        variant="caption"
        role="status"
        sx={{ color: outcome === "ok" ? "success.main" : "warning.main" }}
      >
        {I18n.t(outcome === "ok" ? "aiu_copied" : "aiu_copyManual")}
      </Typography>
    );
  }

  /**
   * The sign-in area of one subscription — the part that differs per provider.
   *
   * @param provider the subscription kind
   */
  private renderSignIn(provider: string): React.JSX.Element {
    const state = this.state.signIn[provider];
    const busy = this.state.busy === provider;

    if (!this.props.alive) {
      return <Alert severity="warning">{I18n.t("aiu_instanceNotRunning")}</Alert>;
    }
    if (this.props.changed) {
      return <Alert severity="info">{I18n.t("aiu_saveFirst")}</Alert>;
    }
    if (!state) {
      return <CircularProgress size={20} />;
    }

    if (state.status === "signed-in") {
      return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <CheckCircleIcon color="success" />
          <Typography sx={{ color: "success.main" }}>{I18n.t("aiu_signedIn")}</Typography>
          <Button
            size="small"
            startIcon={<LogoutIcon />}
            disabled={busy}
            onClick={() => void this.run("signOut", provider)}
          >
            {I18n.t("aiu_signOut")}
          </Button>
        </Box>
      );
    }

    if (state.status === "awaiting-device") {
      return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Typography variant="body2">{I18n.t("aiu_deviceStep1")}</Typography>
          <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
            <Chip
              label={state.userCode}
              sx={{ fontSize: 20, fontFamily: "monospace", py: 2.5, px: 1 }}
            />
            <Button
              size="small"
              startIcon={<ContentCopyIcon />}
              onClick={() => void this.copy(`${provider}-code`, state.userCode)}
            >
              {I18n.t("aiu_copyCode")}
            </Button>
            {this.renderCopied(`${provider}-code`)}
            <Button
              variant="contained"
              startIcon={<LoginIcon />}
              href={state.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {I18n.t("aiu_openPage")}
            </Button>
          </Box>
          <Alert severity="info">{I18n.t("aiu_deviceWaiting")}</Alert>
        </Box>
      );
    }

    if (state.status === "awaiting-paste") {
      const isGoogle = state.flow === "paste-url";
      return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Typography variant="body2">{I18n.t(isGoogle ? "aiu_googleStep1" : "aiu_claudeStep1")}</Typography>
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button
              variant="contained"
              startIcon={<LoginIcon />}
              href={state.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {I18n.t("aiu_openSignIn")}
            </Button>
            <Button
              variant="outlined"
              startIcon={<ContentCopyIcon />}
              onClick={() => void this.copy(`${provider}-link`, state.url)}
            >
              {I18n.t("aiu_copyLink")}
            </Button>
            {this.renderCopied(`${provider}-link`)}
          </Box>
          {isGoogle ? <Alert severity="warning">{I18n.t("aiu_googleErrorPageHint")}</Alert> : null}
          <Typography variant="body2">{I18n.t(isGoogle ? "aiu_googleStep2" : "aiu_claudeStep2")}</Typography>
          <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
            <TextField
              size="small"
              label={I18n.t(isGoogle ? "aiu_addressLabel" : "aiu_codeLabel")}
              value={this.state.drafts[provider] ?? ""}
              onChange={e => this.setState(prev => ({ drafts: { ...prev.drafts, [provider]: e.target.value } }))}
              sx={{ minWidth: 340, flexGrow: 1 }}
            />
            <Button
              variant="contained"
              disabled={busy || !(this.state.drafts[provider] ?? "").trim()}
              onClick={() => void this.run("signInSubmit", provider, this.state.drafts[provider])}
            >
              {busy ? <CircularProgress size={20} /> : I18n.t("aiu_redeem")}
            </Button>
          </Box>
        </Box>
      );
    }

    return (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {state.status === "failed" ? <Alert severity="error">{state.reason}</Alert> : null}
        <Box>
          <Button
            variant="contained"
            startIcon={<LoginIcon />}
            disabled={busy}
            onClick={() => void this.run("signInStart", provider)}
          >
            {busy ? <CircularProgress size={20} /> : I18n.t("aiu_startSignIn")}
          </Button>
        </Box>
      </Box>
    );
  }

  /**
   * One subscription row plus, while switched on, its sign-in area.
   *
   * @param entry the subscription descriptor
   * @param entry.provider
   * @param entry.label
   * @param entry.captionKey
   */
  private renderSubscriptionRow(entry: { provider: string; label: string; captionKey: string }): React.JSX.Element {
    const row = subscriptionRow(this.accounts(), entry.provider);
    return (
      <Box key={entry.provider}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 1, borderBottom: 1, borderColor: "divider" }}>
          <Avatar sx={{ width: 28, height: 28, bgcolor: "transparent" }}>
            <SmartToyIcon
              fontSize="small"
              color="primary"
            />
          </Avatar>
          <Box sx={{ minWidth: 180 }}>
            <Typography>{entry.label}</Typography>
            <Typography
              variant="caption"
              sx={{ opacity: 0.7 }}
            >
              {I18n.t(entry.captionKey)}
            </Typography>
          </Box>
          {row ? this.renderServiceBadge(entry.provider, "") : null}
          {row ? this.renderThreshold(`${entry.provider}-t`, row, { provider: entry.provider }) : null}
          <Switch
            checked={!!row}
            onChange={e =>
              this.commit(toggleSubscription(this.accounts(), entry.provider, e.target.checked, entry.label))
            }
            slotProps={{ input: { "aria-label": entry.label } }}
            sx={{ ml: row ? 0 : "auto" }}
          />
        </Box>
        {row ? this.renderReason(entry.provider, "") : null}
        {row ? (
          <Box sx={{ pl: 6, py: 1.5, borderBottom: 1, borderColor: "divider" }}>
            {this.renderSignIn(entry.provider)}
          </Box>
        ) : null}
      </Box>
    );
  }

  /**
   * One stored-credential row.
   *
   * @param credential the storage entry
   */
  private renderCredentialRow(credential: CredentialEntry): React.JSX.Element {
    const rows = this.accounts();
    const row = rows.find(entry => entry.credentialId === credential.id);
    const offer = offerForCredential(credential.suffix, credential.name);
    const chosen = row?.provider || offer?.provider || this.state.providerChoice[credential.id] || "";
    const needsAdminKey =
      KEY_PROVIDERS.find(entry => entry.provider === chosen)?.needsAdminKey ?? offer?.needsAdminKey ?? false;
    const unusable = !offer && !this.state.providerChoice[credential.id] && !row;

    return (
      <Box
        key={credential.id}
        sx={{ borderBottom: 1, borderColor: "divider" }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 1 }}>
          <Avatar
            src={credential.icon}
            sx={{ width: 28, height: 28, bgcolor: "transparent" }}
          >
            <SmartToyIcon fontSize="small" />
          </Avatar>
          <Box sx={{ minWidth: 180 }}>
            <Typography>{credential.name}</Typography>
            <Typography
              variant="caption"
              sx={{ opacity: 0.7 }}
            >
              {I18n.t("aiu_storedKey")}
            </Typography>
          </Box>
          {unusable ? (
            <TextField
              select
              size="small"
              label={I18n.t("aiu_provider")}
              value={this.state.providerChoice[credential.id] || ""}
              onChange={e =>
                this.setState(prev => ({
                  providerChoice: { ...prev.providerChoice, [credential.id]: e.target.value },
                }))
              }
              sx={{ minWidth: 170 }}
            >
              {KEY_PROVIDERS.map(entry => (
                <MenuItem
                  key={entry.provider}
                  value={entry.provider}
                >
                  {entry.label}
                </MenuItem>
              ))}
            </TextField>
          ) : null}
          {row ? this.renderServiceBadge(row.provider, credential.id) : null}
          {row ? this.renderThreshold(`${credential.id}-t`, row, { credentialId: credential.id }) : null}
          <Switch
            checked={!!row}
            disabled={!chosen}
            onChange={e => this.commit(toggleCredential(rows, credential, chosen, e.target.checked))}
            slotProps={{ input: { "aria-label": credential.name } }}
            sx={{ ml: row ? 0 : "auto" }}
          />
        </Box>
        {row ? this.renderReason(row.provider, credential.id) : null}
        {row && needsAdminKey ? (
          <Alert
            severity="info"
            sx={{ mb: 1 }}
          >
            {I18n.t("aiu_adminKeyHint")}
          </Alert>
        ) : null}
      </Box>
    );
  }

  /** The key rows, or what stands in their place while there are none to show. */
  private renderCredentials(): React.JSX.Element {
    const state = credentialListState(
      this.state.credentialsLoaded,
      this.state.credentialsFailed,
      this.state.credentials.length,
    );
    if (state === "loading") {
      return (
        <CircularProgress
          size={24}
          sx={{ mt: 1 }}
        />
      );
    }
    // Only once the storage WAS read: a failed read cannot tell which keys are gone.
    const orphans = state === "unreadable" ? [] : orphanRows(this.accounts(), this.state.credentials);
    return (
      <>
        {this.state.credentials.map(credential => this.renderCredentialRow(credential))}
        {orphans.map(row => this.renderOrphanRow(row))}
        {state === "unreadable" ? (
          <Alert
            severity="warning"
            sx={{ mt: 1 }}
          >
            {I18n.t("aiu_credentialsUnreadable")}
          </Alert>
        ) : null}
        {state === "empty" ? (
          <Alert
            severity="info"
            sx={{ mt: 1 }}
          >
            {I18n.t("aiu_noCredentials")}
          </Alert>
        ) : null}
      </>
    );
  }

  renderItem(): React.JSX.Element {
    return (
      <Box
        data-testid="aiu-config"
        sx={{ maxWidth: 760 }}
      >
        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="h6"
              sx={{ mb: 0.5 }}
            >
              {I18n.t("aiu_storedTitle")}
            </Typography>
            <Typography
              variant="body2"
              sx={{ opacity: 0.8, mb: 1 }}
            >
              {I18n.t("aiu_storedHint")}
            </Typography>
            {SUBSCRIPTIONS.map(entry => this.renderSubscriptionRow(entry))}
            {this.renderCredentials()}
          </CardContent>
        </Card>
      </Box>
    );
  }
}

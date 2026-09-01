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

import {
  KEY_PROVIDERS,
  SUBSCRIPTIONS,
  offerForCredential,
  setThreshold,
  subscriptionRow,
  accountId,
  serviceBadge,
  toggleCredential,
  toggleSubscription,
  type AccountRow,
  type CredentialEntry,
} from "./rows";

/** What the adapter reports about one subscription's sign-in. */
type SignInState =
  | { status: "signed-in" }
  | { status: "signed-out" }
  | { status: "awaiting-paste"; url: string; flow: "paste-code" | "paste-url" }
  | { status: "awaiting-device"; userCode: string; verificationUrl: string; expiresAt: number }
  | { status: "failed"; reason: string };

interface PanelState extends ConfigGenericState {
  credentials: CredentialEntry[];
  credentialsLoaded: boolean;
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
export default class ConfigPanel extends ConfigGeneric<ConfigGenericProps, PanelState> {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(props: ConfigGenericProps) {
    super(props);
    this.state = {
      ...this.state,
      credentials: [],
      credentialsLoaded: false,
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
    await Promise.all([this.loadCredentials(), this.refresh()]);
    // A device-code sign-in finishes in the adapter, not here — poll while the card is open.
    this.timer = setInterval(() => void this.refresh(), 4000);
  }

  componentWillUnmount(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    super.componentWillUnmount?.();
  }

  /** Read the AI entries of the admin's central credential storage. */
  private async loadCredentials(): Promise<void> {
    try {
      const objects = await this.props.oContext.socket.getObjectViewSystem(
        "config",
        "system.credentials.",
        "system.credentials.香",
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
      this.setState({ credentials, credentialsLoaded: true });
    } catch {
      this.setState({ credentialsLoaded: true });
    }
  }

  /** One poll round: sign-in state of the subscriptions plus every row's service status. */
  private async refresh(): Promise<void> {
    await this.refreshSignIn();
    await this.refreshServiceState();
  }

  /**
   * Read the two status states of every switched-on row.
   *
   * This is what makes the online indicator visible where the user actually looks —
   * the datapoints alone answer the question only for someone who browses the object
   * tree (krobi 2026-08-26).
   */
  private async refreshServiceState(): Promise<void> {
    const ctx = this.props.oContext;
    const serviceState: Record<string, unknown> = {};
    // All rows in one burst — the previous one-after-another loop stretched a
    // poll round to 2×rows round-trips every 4 s while the card is open.
    await Promise.all(
      this.accounts().map(async row => {
        const id = accountId(row.provider, row.credentialId);
        if (!id) {
          return;
        }
        try {
          const [unreach, error] = await Promise.all([
            ctx.socket.getState(`${ctx.adapterName}.${ctx.instance}.${id}.info.unreach`),
            ctx.socket.getState(`${ctx.adapterName}.${ctx.instance}.${id}.info.error`),
          ]);
          if (unreach && unreach.val !== null && unreach.val !== undefined) {
            serviceState[`${id}.unreach`] = unreach.val;
            serviceState[`${id}.error`] = error?.val ?? "";
          }
        } catch {
          // an instance that never ran has no states yet — show nothing, guess nothing
        }
      }),
    );
    this.setState({ serviceState });
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
      SUBSCRIPTIONS.filter(entry => subscriptionRow(this.accounts(), entry.provider)).map(async entry => ({
        provider: entry.provider,
        answer: await this.ask("signInStatus", entry.provider),
      })),
    );
    this.setState(prev => {
      const signIn = { ...prev.signIn };
      for (const { provider, answer } of answers) {
        if (answer) {
          signIn[provider] = answer;
        }
      }
      return { signIn };
    });
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
      const answer = await ctx.socket.sendTo(`${ctx.adapterName}.${ctx.instance}`, command, {
        provider,
        value,
      });
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
    this.setState({ busy: provider });
    const answer = await this.ask(command, provider, value);
    // Unlike the background status poll, an explicit click deserves an answer:
    // no answer at all is shown as exactly that, never silently swallowed.
    const shown: SignInState | null = answer ?? { status: "failed", reason: I18n.t("aiu_noAnswer") };
    this.setState(prev => ({
      busy: "",
      signIn: { ...prev.signIn, [provider]: shown },
      drafts: { ...prev.drafts, [provider]: "" },
    }));
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
    return (
      <TextField
        key={key}
        size="small"
        type="number"
        label={I18n.t("aiu_warnAt")}
        defaultValue={row.warnThreshold || 80}
        onBlur={e => this.commit(setThreshold(this.accounts(), match, e.target.value))}
        slotProps={{ htmlInput: { min: 10, max: 100, style: { width: 60 } }, inputLabel: { shrink: true } }}
        sx={{ ml: "auto" }}
      />
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
              onClick={() => void navigator.clipboard?.writeText(state.userCode)}
            >
              {I18n.t("aiu_copyCode")}
            </Button>
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
              onClick={() => void navigator.clipboard?.writeText(state.url)}
            >
              {I18n.t("aiu_copyLink")}
            </Button>
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
            sx={{ ml: row ? 0 : "auto" }}
          />
        </Box>
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
            sx={{ ml: row ? 0 : "auto" }}
          />
        </Box>
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
            {!this.state.credentialsLoaded ? (
              <CircularProgress
                size={24}
                sx={{ mt: 1 }}
              />
            ) : (
              this.state.credentials.map(credential => this.renderCredentialRow(credential))
            )}
            {this.state.credentialsLoaded && this.state.credentials.length === 0 ? (
              <Alert
                severity="info"
                sx={{ mt: 1 }}
              >
                {I18n.t("aiu_noCredentials")}
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      </Box>
    );
  }
}

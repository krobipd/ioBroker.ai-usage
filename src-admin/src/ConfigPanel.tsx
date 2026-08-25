import React from "react";

import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import LoginIcon from "@mui/icons-material/Login";
import RefreshIcon from "@mui/icons-material/Refresh";
import SmartToyIcon from "@mui/icons-material/SmartToy";

import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from "@iobroker/json-config";
import { I18n } from "@iobroker/gui-components";

/** One row of the adapter's `native.accounts` (kept compatible with the backend parser). */
interface AccountRow {
  name: string;
  provider: string;
  credentialId: string;
  warnThreshold: number;
  enabled: boolean;
}

/** The provider kinds the panel can assign. */
export type ProviderKind = "openrouter" | "deepseek" | "openai" | "anthropic-api";

/** One entry of the admin's central credential storage (category "AI"). */
interface CredentialEntry {
  /** Full object id (system.credentials.<name>). */
  id: string;
  /** The id suffix — used as default account name. */
  suffix: string;
  /** Display name. */
  name: string;
  /** Icon data URL from the storage, if any. */
  icon?: string;
  /** Auto-detected provider, null when the user has to pick, "unsupported" for known-but-unusable. */
  guess: ProviderKind | null | "unsupported";
}

interface PanelState extends ConfigGenericState {
  credentials: CredentialEntry[];
  credentialsLoaded: boolean;
  claudeUrl: string;
  claudeSignedIn: boolean;
  code: string;
  busy: boolean;
  message: { ok: boolean; text: string } | null;
  /** Provider picked for credentials the auto-detection could not resolve. */
  providerChoice: Record<string, string>;
}

/** The fixed row name of the Claude subscription account (id-safe as-is). */
const CLAUDE_NAME = "Claude";

const PROVIDER_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  openai: "OpenAI",
  "anthropic-api": "Anthropic",
};

/**
 * Guess the provider of a stored credential from its id and display name (the
 * storage records only the category "AI", not the provider).
 *
 * @param suffix the credential id suffix
 * @param name the display name
 * @returns the provider kind, "unsupported" (Gemini), or null when unknown
 */
export function guessProvider(suffix: string, name: string): ProviderKind | null | "unsupported" {
  const hay = `${suffix} ${name}`.toLowerCase();
  if (hay.includes("gemini")) {
    return "unsupported";
  }
  if (hay.includes("anthropic")) {
    return "anthropic-api";
  }
  if (hay.includes("chatgpt") || hay.includes("openai")) {
    return "openai";
  }
  if (hay.includes("deepseek")) {
    return "deepseek";
  }
  if (hay.includes("openrouter") || hay.includes("router")) {
    return "openrouter";
  }
  return null;
}

/**
 * The whole instance configuration as one guided card set: the Claude
 * subscription with its sign-in flow on top, then every credential of the
 * admin's central storage (category "AI") as a simple on/off switch. Owns the
 * `accounts` native field; the backend model is unchanged.
 */
export default class ConfigPanel extends ConfigGeneric<ConfigGenericProps, PanelState> {
  private urlId = "";
  private connId = "";

  constructor(props: ConfigGenericProps) {
    super(props);
    this.state = {
      ...this.state,
      credentials: [],
      credentialsLoaded: false,
      claudeUrl: "",
      claudeSignedIn: false,
      code: "",
      busy: false,
      message: null,
      providerChoice: {},
    };
  }

  private readonly onUrl = (_id: string, state: ioBroker.State | null | undefined): void => {
    this.setState({ claudeUrl: typeof state?.val === "string" ? state.val : "" });
  };

  private readonly onConn = (_id: string, state: ioBroker.State | null | undefined): void => {
    this.setState({ claudeSignedIn: state?.val === true });
  };

  async componentDidMount(): Promise<void> {
    void super.componentDidMount?.();
    const ctx = this.props.oContext;
    const ns = `${ctx.adapterName}.${ctx.instance}`;
    this.urlId = `${ns}.auth.${CLAUDE_NAME}.signInUrl`;
    this.connId = `${ns}.auth.${CLAUDE_NAME}.signedIn`;
    try {
      const objects = await ctx.socket.getObjectViewSystem("config", "system.credentials.", "system.credentials.香");
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
            guess: guessProvider(suffix, name),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      this.setState({ credentials, credentialsLoaded: true });
    } catch {
      this.setState({ credentialsLoaded: true });
    }
    try {
      const [url, conn] = await Promise.all([ctx.socket.getState(this.urlId), ctx.socket.getState(this.connId)]);
      this.setState({
        claudeUrl: typeof url?.val === "string" ? url.val : "",
        claudeSignedIn: conn?.val === true,
      });
      await ctx.socket.subscribeState(this.urlId, this.onUrl);
      await ctx.socket.subscribeState(this.connId, this.onConn);
    } catch {
      // The states appear once the adapter first runs with a Claude account — the hint covers it.
    }
  }

  componentWillUnmount(): void {
    const socket = this.props.oContext?.socket;
    if (socket && this.urlId) {
      socket.unsubscribeState(this.urlId, this.onUrl);
      socket.unsubscribeState(this.connId, this.onConn);
    }
    super.componentWillUnmount?.();
  }

  /** The current accounts rows from the (unsaved) config data. */
  private accounts(): AccountRow[] {
    const value = ConfigGeneric.getValue(this.props.data, "accounts") as unknown;
    return Array.isArray(value) ? (value as AccountRow[]) : [];
  }

  /**
   * Commit a new accounts array into the config data (saved with the form).
   *
   * @param rows the new rows
   */
  private commit(rows: AccountRow[]): void {
    void this.onChange("accounts", rows);
  }

  /** Whether the Claude subscription row exists (enabled). */
  private claudeEnabled(): boolean {
    return this.accounts().some(row => row.provider === "claude-sub");
  }

  private toggleClaude(on: boolean): void {
    const rows = this.accounts().filter(row => row.provider !== "claude-sub");
    if (on) {
      rows.unshift({ name: CLAUDE_NAME, provider: "claude-sub", credentialId: "", warnThreshold: 80, enabled: true });
    }
    this.commit(rows);
  }

  /**
   * Toggle monitoring of one stored credential.
   *
   * @param credential the storage entry
   * @param on the new switch state
   */
  private toggleCredential(credential: CredentialEntry, on: boolean): void {
    const rows = this.accounts().filter(row => row.credentialId !== credential.id);
    if (on) {
      const provider =
        credential.guess && credential.guess !== "unsupported"
          ? credential.guess
          : this.state.providerChoice[credential.id];
      if (!provider) {
        return;
      }
      rows.push({ name: credential.name, provider, credentialId: credential.id, warnThreshold: 80, enabled: true });
    }
    this.commit(rows);
  }

  /**
   * Update the warn threshold of one row.
   *
   * @param credentialId the row key ("" for Claude)
   * @param value the raw input value
   */
  private setThreshold(credentialId: string, value: string): void {
    const threshold = Math.min(100, Math.max(10, Math.round(Number(value)) || 80));
    this.commit(
      this.accounts().map(row =>
        (credentialId ? row.credentialId === credentialId : row.provider === "claude-sub")
          ? { ...row, warnThreshold: threshold }
          : row,
      ),
    );
  }

  /** Redeem the pasted sign-in code via the running instance. */
  private async redeemCode(): Promise<void> {
    const ctx = this.props.oContext;
    this.setState({ busy: true, message: null });
    try {
      const response = await ctx.socket.sendTo(`${ctx.adapterName}.${ctx.instance}`, "claudeAuthCode", {
        account: CLAUDE_NAME,
        code: this.state.code,
      });
      if (response?.result === "ok") {
        this.setState({ busy: false, code: "", message: { ok: true, text: I18n.t("aiu_signInDone") } });
      } else {
        this.setState({ busy: false, message: { ok: false, text: response?.error || I18n.t("aiu_signInFailed") } });
      }
    } catch {
      this.setState({ busy: false, message: { ok: false, text: I18n.t("aiu_instanceNotRunning") } });
    }
  }

  /** Ask the instance for a fresh sign-in link (invalidates the previous one). */
  private async newLink(): Promise<void> {
    const ctx = this.props.oContext;
    this.setState({ busy: true, message: null });
    try {
      await ctx.socket.sendTo(`${ctx.adapterName}.${ctx.instance}`, "claudeAuthStart", { account: CLAUDE_NAME });
      this.setState({ busy: false });
    } catch {
      this.setState({ busy: false, message: { ok: false, text: I18n.t("aiu_instanceNotRunning") } });
    }
  }

  /**
   * The threshold input of one enabled row (uncontrolled — committed on blur).
   *
   * @param credentialId the row key ("" for Claude)
   * @param row the row
   */
  private renderThreshold(credentialId: string, row: AccountRow): React.JSX.Element {
    return (
      <TextField
        key={`${credentialId}-threshold`}
        size="small"
        type="number"
        label={I18n.t("aiu_warnAt")}
        defaultValue={row.warnThreshold || 80}
        onBlur={e => this.setThreshold(credentialId, e.target.value)}
        slotProps={{ htmlInput: { min: 10, max: 100, style: { width: 60 } }, inputLabel: { shrink: true } }}
        sx={{ ml: "auto" }}
      />
    );
  }

  private renderClaudeCard(): React.JSX.Element {
    const enabled = this.claudeEnabled();
    const row = this.accounts().find(r => r.provider === "claude-sub");
    return (
      <Card
        variant="outlined"
        sx={{ mb: 2 }}
      >
        <CardContent>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <SmartToyIcon color="primary" />
            <Typography variant="h6">{I18n.t("aiu_claudeTitle")}</Typography>
            <Switch
              checked={enabled}
              onChange={e => this.toggleClaude(e.target.checked)}
              sx={{ ml: 1 }}
            />
            {enabled && row ? this.renderThreshold("", row) : null}
          </Box>
          <Typography
            variant="body2"
            sx={{ opacity: 0.8, mb: enabled ? 1.5 : 0 }}
          >
            {I18n.t("aiu_claudeSubtitle")}
          </Typography>
          {enabled ? this.renderClaudeAuth() : null}
        </CardContent>
      </Card>
    );
  }

  private renderClaudeAuth(): React.JSX.Element {
    if (this.state.claudeSignedIn) {
      return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <CheckCircleIcon color="success" />
          <Typography sx={{ color: "success.main" }}>{I18n.t("aiu_signedIn")}</Typography>
          <Button
            size="small"
            startIcon={<RefreshIcon />}
            disabled={this.state.busy}
            onClick={() => void this.newLink()}
          >
            {I18n.t("aiu_signInAgain")}
          </Button>
        </Box>
      );
    }
    if (!this.state.claudeUrl) {
      return (
        <Alert severity="info">{this.props.changed ? I18n.t("aiu_saveFirst") : I18n.t("aiu_waitingForLink")}</Alert>
      );
    }
    return (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
        <Typography variant="body2">{I18n.t("aiu_step1")}</Typography>
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          <Button
            variant="contained"
            startIcon={<LoginIcon />}
            href={this.state.claudeUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {I18n.t("aiu_openSignIn")}
          </Button>
          <Button
            variant="outlined"
            startIcon={<ContentCopyIcon />}
            onClick={() => void navigator.clipboard?.writeText(this.state.claudeUrl)}
          >
            {I18n.t("aiu_copyLink")}
          </Button>
        </Box>
        <Typography variant="body2">{I18n.t("aiu_step2")}</Typography>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
          <TextField
            size="small"
            label={I18n.t("aiu_codeLabel")}
            value={this.state.code}
            onChange={e => this.setState({ code: e.target.value })}
            sx={{ minWidth: 320 }}
          />
          <Button
            variant="contained"
            disabled={!this.state.code.trim() || this.state.busy || !this.props.alive}
            onClick={() => void this.redeemCode()}
          >
            {this.state.busy ? <CircularProgress size={20} /> : I18n.t("aiu_redeem")}
          </Button>
        </Box>
        {!this.props.alive ? <Alert severity="warning">{I18n.t("aiu_instanceNotRunning")}</Alert> : null}
        {this.state.message ? (
          <Alert severity={this.state.message.ok ? "success" : "error"}>{this.state.message.text}</Alert>
        ) : null}
      </Box>
    );
  }

  private renderCredentialRow(credential: CredentialEntry): React.JSX.Element {
    const row = this.accounts().find(r => r.credentialId === credential.id);
    const unsupported = credential.guess === "unsupported";
    const needsChoice = credential.guess === null && !row;
    const provider =
      row?.provider ||
      (credential.guess !== "unsupported" && credential.guess) ||
      this.state.providerChoice[credential.id] ||
      "";
    return (
      <Box
        key={credential.id}
        sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 1, borderBottom: 1, borderColor: "divider" }}
      >
        <Avatar
          src={credential.icon}
          sx={{ width: 28, height: 28, bgcolor: "transparent" }}
        >
          <SmartToyIcon fontSize="small" />
        </Avatar>
        <Box sx={{ minWidth: 160 }}>
          <Typography>{credential.name}</Typography>
          <Typography
            variant="caption"
            sx={{ opacity: 0.7 }}
          >
            {unsupported ? I18n.t("aiu_unsupported") : PROVIDER_LABELS[provider] || ""}
          </Typography>
        </Box>
        {needsChoice ? (
          <TextField
            select
            size="small"
            label={I18n.t("aiu_provider")}
            value={this.state.providerChoice[credential.id] || ""}
            onChange={e =>
              this.setState({ providerChoice: { ...this.state.providerChoice, [credential.id]: e.target.value } })
            }
            sx={{ minWidth: 160 }}
          >
            {Object.entries(PROVIDER_LABELS).map(([kind, label]) => (
              <MenuItem
                key={kind}
                value={kind}
              >
                {label}
              </MenuItem>
            ))}
          </TextField>
        ) : null}
        {row ? this.renderThreshold(credential.id, row) : null}
        <Switch
          checked={!!row}
          disabled={unsupported || (needsChoice && !this.state.providerChoice[credential.id])}
          onChange={e => this.toggleCredential(credential, e.target.checked)}
          sx={{ ml: row ? 0 : "auto" }}
        />
      </Box>
    );
  }

  renderItem(): React.JSX.Element {
    return (
      <Box
        data-testid="aiu-config"
        sx={{ maxWidth: 720 }}
      >
        {this.renderClaudeCard()}
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
            {!this.state.credentialsLoaded ? (
              <CircularProgress size={24} />
            ) : this.state.credentials.length === 0 ? (
              <Alert severity="info">{I18n.t("aiu_noCredentials")}</Alert>
            ) : (
              this.state.credentials.map(credential => this.renderCredentialRow(credential))
            )}
          </CardContent>
        </Card>
      </Box>
    );
  }
}

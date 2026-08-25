import { getJson, type JsonFetch } from "../http";
import { FetchError, type LimitWindow, type UsageProvider, type UsageSnapshot } from "../provider";
import { sanitizeId } from "../pure-helpers";
import { CLAUDE_OAUTH, refreshTokens, type JsonPost, type TokenSet } from "./claude-auth";

/**
 * Parse a Claude subscription `GET /api/oauth/usage` response into a snapshot.
 *
 * Source-verified against the HA reference integration (trickv/hass-claude-usage):
 * the LIVE per-scope meters are the top-level `limits[]` array (kind session /
 * weekly_all / weekly_scoped + scope.model/surface, percent, resets_at); the flat
 * `five_hour`/`seven_day*` keys are placeholders on current accounts and serve only
 * as a fallback. Extra usage arrives as `extra_usage` (credits × decimal_places) or
 * the newer `spend` schema (money objects with amount_minor/exponent).
 *
 * @param body the usage response
 * @returns the snapshot
 */
export function parseClaudeUsage(body: unknown): UsageSnapshot {
  if (typeof body !== "object" || body === null) {
    throw new FetchError("network", "unexpected usage response");
  }
  const raw = body as Record<string, unknown>;
  const limits: LimitWindow[] = [];
  const seen = new Set<string>();
  const push = (name: string, label: string, percent: unknown, resetsAt: unknown): void => {
    const id = sanitizeId(name);
    const value = Number(percent);
    if (!id || seen.has(id) || !Number.isFinite(value)) {
      return;
    }
    seen.add(id);
    const window: LimitWindow = { name: id, label, percent: value };
    if (typeof resetsAt === "string" && resetsAt) {
      window.resetAt = resetsAt;
    }
    limits.push(window);
  };

  // The live meters: limits[] — buckets keyed by kind + model + surface.
  if (Array.isArray(raw.limits)) {
    for (const entry of raw.limits) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const limit = entry as Record<string, unknown>;
      const kind = typeof limit.kind === "string" ? limit.kind : "";
      if (!kind) {
        continue;
      }
      const scope = (limit.scope ?? {}) as Record<string, unknown>;
      const model = ((scope.model ?? {}) as Record<string, unknown>).display_name;
      const surface = scope.surface;
      const nameParts = [kind === "session" ? "session" : kind === "weekly_all" ? "week" : kind];
      const labelParts = [
        kind === "session" ? "Session (5 h)" : kind === "weekly_all" ? "Week (all models)" : kind.replace(/_/g, " "),
      ];
      if (typeof model === "string" && model) {
        nameParts.push(model);
        labelParts.push(model);
      }
      if (typeof surface === "string" && surface) {
        nameParts.push(surface);
        labelParts.push(`(${surface})`);
      }
      push(nameParts.join("-"), labelParts.join(" "), limit.percent, limit.resets_at);
    }
  }

  // Fallback for older payloads without the limits[] array.
  if (limits.length === 0) {
    const flat = (key: string, name: string, label: string): void => {
      const block = raw[key];
      if (typeof block === "object" && block !== null) {
        const data = block as Record<string, unknown>;
        push(name, label, data.utilization, data.resets_at);
      }
    };
    flat("five_hour", "session", "Session (5 h)");
    flat("seven_day", "week", "Week (all models)");
    flat("seven_day_sonnet", "week-sonnet", "Week Sonnet");
  }

  const snapshot: UsageSnapshot = {};
  if (limits.length > 0) {
    snapshot.limits = limits;
  }
  applyExtraUsage(raw, snapshot);
  return snapshot;
}

/**
 * Map the extra-usage block (either schema) onto credits + monthly costs.
 *
 * @param raw the usage response
 * @param snapshot the snapshot to extend
 */
function applyExtraUsage(raw: Record<string, unknown>, snapshot: UsageSnapshot): void {
  const extra = raw.extra_usage as Record<string, unknown> | undefined | null;
  const spend = raw.spend as Record<string, unknown> | undefined | null;
  if (extra && extra.is_enabled === true) {
    const divisor = 10 ** (Number.isFinite(Number(extra.decimal_places)) ? Number(extra.decimal_places) : 2);
    const used = Number(extra.used_credits);
    const limit = Number(extra.monthly_limit);
    const percent = Number(extra.utilization);
    snapshot.credits = {
      used: Number.isFinite(used) ? used / divisor : undefined,
      limit: Number.isFinite(limit) ? limit / divisor : undefined,
      percent: Number.isFinite(percent) ? percent : undefined,
      currency: "USD",
    };
    if (snapshot.credits.used !== undefined) {
      snapshot.costs = { month: snapshot.credits.used, currency: "USD" };
    }
    return;
  }
  if (spend && spend.enabled === true) {
    const money = (value: unknown): number | undefined => {
      const obj = value as Record<string, unknown> | null | undefined;
      const amount = Number(obj?.amount_minor);
      const exponent = Number(obj?.exponent);
      return Number.isFinite(amount) ? amount / 10 ** (Number.isFinite(exponent) ? exponent : 2) : undefined;
    };
    const used = money(spend.used);
    const percent = Number(spend.percent);
    snapshot.credits = {
      used,
      limit: money(spend.limit),
      percent: Number.isFinite(percent) ? percent : undefined,
      currency: "USD",
    };
    if (used !== undefined) {
      snapshot.costs = { month: used, currency: "USD" };
    }
  }
}

/** Persistent token storage — the adapter keeps the tokens in its data directory. */
export interface TokenStore {
  /** Read the stored token set, or null when never signed in. */
  load(): Promise<TokenSet | null>;
  /** Persist a token set. */
  save(tokens: TokenSet): Promise<void>;
}

/**
 * The Claude subscription provider: keeps the access token fresh (refresh 60 s
 * before expiry, persisted via the store) and reads the usage meters.
 *
 * @param store the token storage
 * @param fetchJson the JSON-GET seam
 * @param postJson the JSON-POST seam (token refresh)
 * @param now clock (ms) — injected for tests
 * @returns the provider
 */
export function claudeSubProvider(
  store: TokenStore,
  fetchJson: JsonFetch = getJson,
  postJson: JsonPost,
  now: () => number = Date.now,
): UsageProvider {
  let cached: TokenSet | null = null;
  return {
    kind: "claude-sub",
    fetch: async (): Promise<UsageSnapshot> => {
      cached ??= await store.load();
      if (!cached) {
        throw new FetchError("auth", "not signed in — run the Claude sign-in in the instance settings");
      }
      if (now() >= cached.expiresAt - 60_000) {
        cached = await refreshTokens(cached, postJson, now());
        await store.save(cached);
      }
      const body = await fetchJson(CLAUDE_OAUTH.usageUrl, {
        Authorization: `Bearer ${cached.accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH.betaHeader,
        // Identify ourselves — an unset/odd user agent lands in a harder-throttled
        // bucket of this endpoint (community-measured; sources in the concept doc).
        "User-Agent": "ioBroker.ai-usage",
      });
      return parseClaudeUsage(body);
    },
  };
}

"use strict";
// The answers every provider gives during the inventory run.
//
// Shapes are the REAL ones: the Claude payload is a live response captured on
// 2026-09-06 (account identifiers removed), the others follow the fixtures the
// parser tests are built on, which in turn came from the providers' own clients
// and their documentation. This is the whole point of the inventory — it covers
// every account type the community may own, not only the maintainer's Claude
// subscription (`feedback_user_hardware_ist_sample`).
//
// Anything time-dependent is derived from the current day, so that the SET of
// objects an answer produces is the same on every run: a cost report whose
// buckets were not "today" would create no token datapoints tomorrow.

/** Today at 00:00 UTC as unix seconds — the bucket the report providers read. */
function todayUnix() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
}

/** Today at 00:00 UTC as an ISO timestamp. */
function todayIso() {
  return new Date(todayUnix() * 1000).toISOString();
}

/**
 * A JWT the adapter can read claims out of. Not signed — the adapter is the
 * token's holder, not its verifier (see lib/jwt.ts).
 *
 * @param {Record<string, unknown>} payload the claims
 * @returns {string} the compact token
 */
function jwt(payload) {
  const part = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(payload)}.sig`;
}

const CHATGPT_ID_TOKEN = jwt({
  exp: Math.floor(Date.now() / 1000) + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
});

/** OAuth tokens, in the three shapes the three providers answer with. */
const TOKENS = {
  claude: { access_token: "fixture-claude-access", refresh_token: "fixture-claude-refresh", expires_in: 3600 },
  chatgpt: { access_token: CHATGPT_ID_TOKEN, refresh_token: "fixture-chatgpt-refresh", id_token: CHATGPT_ID_TOKEN },
  gemini: { access_token: "fixture-gemini-access", refresh_token: "fixture-gemini-refresh", expires_in: 3600 },
};

/**
 * Every route the adapter calls, most specific first.
 *
 * @returns {{match: string, body: unknown}[]} the routing table
 */
function routes() {
  return [
    // ---- Claude subscription: token endpoint + usage (live shape, 2026-09-06)
    { match: "console.anthropic.com/v1/oauth/token", body: TOKENS.claude },
    {
      match: "api.anthropic.com/api/oauth/usage",
      body: {
        five_hour: {
          utilization: 8,
          resets_at: "2026-09-06T14:09:59.898660+00:00",
          limit_dollars: null,
          used_dollars: null,
          remaining_dollars: null,
          locked_reason: null,
        },
        seven_day: {
          utilization: 54,
          resets_at: "2026-09-07T18:59:59.898682+00:00",
          limit_dollars: null,
          used_dollars: null,
          remaining_dollars: null,
          locked_reason: null,
        },
        seven_day_opus: null,
        seven_day_sonnet: null,
        extra_usage: {
          is_enabled: true,
          monthly_limit: 5000,
          used_credits: 1234,
          utilization: 24,
          currency: "USD",
          decimal_places: 2,
        },
        limits: [
          { kind: "session", group: "session", percent: 8, severity: "normal", scope: null, is_active: false },
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 54,
            severity: "normal",
            resets_at: "2026-09-07T18:59:59.898682+00:00",
            scope: null,
            is_active: false,
          },
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 97,
            severity: "critical",
            resets_at: "2026-09-07T18:59:59.898933+00:00",
            scope: { model: { id: null, display_name: "Fable" }, surface: null },
            is_active: true,
          },
        ],
      },
    },

    // ---- ChatGPT/Codex subscription: device code, tokens, usage, vouchers
    {
      match: "auth.openai.com/api/accounts/deviceauth/usercode",
      body: { device_auth_id: "fixture-device", user_code: "FIXT-URE1", interval: "1" },
    },
    {
      match: "auth.openai.com/api/accounts/deviceauth/token",
      body: { authorization_code: "fixture-code", code_verifier: "fixture-verifier" },
    },
    { match: "auth.openai.com/oauth/token", body: TOKENS.chatgpt },
    {
      match: "chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      body: {
        credits: [
          {
            id: "v1",
            reset_type: "primary",
            status: "available",
            granted_at: todayIso(),
            expires_at: "2026-12-31T23:59:59Z",
          },
          {
            id: "v2",
            reset_type: "primary",
            status: "used",
            granted_at: todayIso(),
            expires_at: "2026-12-31T23:59:59Z",
          },
        ],
        available_count: 1,
      },
    },
    {
      match: "chatgpt.com/backend-api/wham/usage",
      body: {
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 31, reset_at: todayUnix() + 5 * 3600, window_minutes: 300 },
          secondary_window: { used_percent: 66, reset_at: todayUnix() + 7 * 86400, window_minutes: 10080 },
        },
        additional_rate_limits: [
          { limit_name: "GPT-5 Pro", rate_limit: { used_percent: 12, reset_at: todayUnix() + 86400 } },
        ],
        credits: { balance: 42.5, unlimited: false },
      },
    },

    // ---- Google/Gemini subscription: token endpoint + Code-Assist
    { match: "oauth2.googleapis.com/token", body: TOKENS.gemini },
    {
      match: ":loadCodeAssist",
      body: { cloudaicompanionProject: "fixture-project", paidTier: { id: "ultra", name: "Google AI Ultra" } },
    },
    {
      match: ":retrieveUserQuota",
      body: {
        buckets: [
          { modelId: "gemini-3-pro", tokenType: "MODEL", remainingFraction: 0.42, resetTime: "2026-09-07T00:00:00Z" },
          { modelId: "gemini-3-flash", tokenType: "MODEL", remainingFraction: 0.9, resetTime: "2026-09-07T00:00:00Z" },
        ],
      },
    },

    // ---- Key accounts
    {
      match: "openrouter.ai/api/v1/auth/key",
      body: { data: { label: "fixture", usage: 12.5, limit: 50, limit_remaining: 37.5, is_free_tier: false } },
    },
    {
      match: "api.deepseek.com/user/balance",
      body: {
        is_available: true,
        balance_infos: [
          { currency: "USD", total_balance: "18.20", granted_balance: "5.00", topped_up_balance: "13.20" },
        ],
      },
    },
    {
      match: "api.openai.com/v1/organization/usage/completions",
      body: {
        data: [
          {
            start_time: todayUnix(),
            results: [
              { input_tokens: 120000, output_tokens: 24000, model: "gpt-5" },
              { input_tokens: 40000, output_tokens: 8000, model: "gpt-5-mini" },
            ],
          },
        ],
        has_more: false,
        next_page: null,
      },
    },
    {
      match: "api.openai.com/v1/organization/costs",
      body: {
        data: [{ start_time: todayUnix(), results: [{ amount: { value: 3.42, currency: "usd" } }] }],
        has_more: false,
        next_page: null,
      },
    },
    {
      match: "api.anthropic.com/v1/organizations/usage_report/messages",
      body: {
        data: [{ starting_at: todayIso(), results: [{ uncached_input_tokens: 88000, output_tokens: 17000 }] }],
        has_more: false,
        next_page: null,
      },
    },
    {
      match: "api.anthropic.com/v1/organizations/cost_report",
      body: { data: [{ starting_at: todayIso(), results: [{ amount: "5.75" }] }], has_more: false, next_page: null },
    },
  ];
}

module.exports = { routes, todayUnix, todayIso };

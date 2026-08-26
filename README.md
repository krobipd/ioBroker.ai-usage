# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.ai-usage@main/admin/ai-usage.svg?v=4" width="48" align="top" /> ioBroker.ai-usage

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.ai-usage)](https://www.npmjs.com/package/iobroker.ai-usage) ![stable](https://iobroker.live/badges/ai-usage-stable.svg) ![Installations](https://iobroker.live/badges/ai-usage-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.ai-usage)](https://www.npmjs.com/package/iobroker.ai-usage)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.ai-usage/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.ai-usage/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Sentry](https://img.shields.io/badge/error%20reporting-Sentry-362d59?logo=sentry&logoColor=white)](https://github.com/ioBroker/plugin-sentry#plugin-sentry)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Monitors your AI accounts in ioBroker: usage windows, limits, credits and costs of your
Claude, ChatGPT and Google subscriptions plus OpenRouter, DeepSeek, OpenAI and Anthropic API
accounts — as clean datapoints for dashboards, history and automations ("send a message at
90 % of the weekly limit").

---

## Features

- **Per-account monitoring** — one device node per AI account with harmonised datapoints: limit windows (percent + reset time), credits, costs and tokens
- **Totals** — summed costs, the highest limit utilisation across all accounts, and one `limitReached` trigger for automations
- **Warn threshold per account** — a single notification when an account crosses its threshold
- **Three subscriptions** — Claude, ChatGPT and Google are signed in with your own account; the settings page guides each sign-in step by step
- **Central credentials** — API keys live in the admin's central credential storage and are shared with the admin AI assistant
- **Read-only by design** — the adapter only reads usage data; it never calls, configures or writes to any AI service
- **Online status per account** — ioBroker's standard offline marker plus a plain-text reason that tells "the AI service is down" apart from "your sign-in is rejected"
- **Throttle-safe polling** — a hard minimum interval and automatic backoff protect your accounts from provider rate-limit lockouts

---

## Sentry / Error reporting

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Reporting only happens if you have enabled error reporting in the ioBroker diagnostics (**System settings → Diagnostics and error reporting**). Only an anonymous installation ID is transmitted — no name, e-mail address or IP address.

For details and how to disable it, see the [Sentry plugin documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry). Error reporting requires js-controller 3.0 or newer.

---

## Requirements

- Node.js >= 22
- ioBroker js-controller >= 7.2.2
- **ioBroker Admin >= 8.0.1** — the adapter uses the admin's central credential storage

---

## Configuration

The instance settings show one list of AI accounts. Switch on what you want to monitor:

| Account | How it is connected |
|---------|---------------------|
| **Claude subscription** | Sign in once with your Claude account (guided, in the settings) |
| **ChatGPT subscription** | Sign in once with your ChatGPT account (guided, in the settings) |
| **Google/Gemini subscription** | Sign in once with your Google account (guided, in the settings) |
| **OpenRouter, DeepSeek** | Pick the stored key from the admin's central credential storage |
| **OpenAI, Anthropic (organisation)** | Needs an **admin key** of your organisation — see below |

### Signing in to a subscription

Each provider needs a different last step, and the settings page tells you which one:

- **Claude** — open the sign-in page, log in, copy the code shown there and paste it back.
- **ChatGPT** — the adapter shows a short code; type it on the OpenAI page it links to. The
  settings page notices by itself once you confirmed. The adapter signs in separately from the
  Codex CLI and does not disturb its session.
- **Google/Gemini** — open the sign-in page and log in. Google then sends the result to
  `localhost`, so **your browser shows an error page ("site cannot be reached"). That is expected**
  — the address bar still carries the sign-in result. Copy the **whole address** and paste it back.

> The three subscription endpoints are **not officially documented**. They are the same ones the
> providers' own tools use, but they can change without notice. If a subscription stops delivering
> data, that is the likely reason.
>
> **Verification status:** the Claude sign-in and read-out were tested against a live subscription.
> ChatGPT and Google/Gemini were built from the requests those providers' own tools make, but no
> live subscription of either was available to test them on — please open an issue if a value looks
> wrong or a sign-in step behaves differently than described.

### API accounts with a key

Keys come from the admin's central credential storage (Settings → Credentials) and are shared with
the admin AI assistant. Two of them need a **different** key than the assistant uses:

- **OpenAI** — the usage and cost reports are organisation endpoints and need an **admin key**
  created in the organisation settings.
- **Anthropic** — same, an **admin key** (`sk-ant-admin…`), which only an organisation
  administrator can create. Personal accounts without an organisation cannot deliver these reports
  at all; use the Claude subscription row instead.

Add such a key as its own entry in the credential storage (template "Key") and pick it in the row.

| Option | Description | Default |
|--------|-------------|---------|
| **Warn at %** | Per account: one notification when a plan-wide limit window crosses this utilisation | 80 |
| **Poll interval** | How often each account is queried, 60–3600 seconds. The floor is deliberate — asking too often gets the account throttled by the provider | 300 |
| **Notifications** | One notification on threshold crossing or broken credentials | on |

---

## State Tree

```
ai-usage.0.
├── info.connection            — at least one account is delivering data (bool)
├── total.                     — totals across all accounts
│   ├── costs.today/month/…    — summed real money (same currency only)
│   ├── maxLimitPercent        — highest plan-wide utilisation of any account
│   ├── warningsActive         — number of accounts above their threshold
│   ├── limitReached           — a plan-wide window is full (automation trigger)
│   ├── accountsReachable      — accounts currently delivering data
│   └── accounts               — configured accounts
├── claude / chatgpt / gemini  — one node per subscription
│   ├── warning                — this account is above its warn threshold (bool)
│   ├── limitReached           — a plan-wide window of this account is full (bool)
│   ├── info.unreach           — the AI service is not reachable (bool, ioBroker's offline marker)
│   ├── info.error             — why there is no data, in plain text; empty while all is well
│   ├── info.lastUpdate        — time of the last successful read
│   ├── limits.<window>.*      — percent + reset time (session, week, per model, …)
│   └── credits.*              — where the provider reports a balance
└── <name>-api                 — one node per key-based account
    ├── warning / limitReached — same triggers as above
    ├── info.*                 — same three status states as above
    ├── credits.* / costs.*    — granted budget and real money
    └── tokens.*               — token counters
```

Only what an account's source actually delivers is created.

### Is it online?

**`info.unreach`** is the online/offline marker — the same one ioBroker uses for every device,
so the account shows up as offline wherever your visualisation or script looks for it. It goes
on only when the AI service itself did not answer: a fault reported by the service switches it
on immediately, an unreachable host after three attempts in a row, so a single hiccup does not
make it flap.

**`info.error`** says what is wrong, in a sentence you can read:

| Situation | `info.unreach` | `info.error` |
|-----------|----------------|--------------|
| Everything works | off | empty |
| Sign-in or key rejected | **off** — the service answered, only your access is broken | `Sign-in rejected — …` |
| Throttled by the provider | **off** — the service answered; last values are kept | `Throttled by the provider — retrying in 10 min …` |
| The service reports a fault | **on** | `The AI service reports a fault — HTTP 503` |
| Not reachable at all | **on** | `Not reachable after 3 attempts — …` |

### Which limit raises the warning

Only **plan-wide** windows — your session and your week — decide `warning`, `limitReached` and
`total.maxLimitPercent`, and the warning always names the window it came from. A window that
belongs to a single model keeps its own datapoints but stays out of it: a model you never use can
sit at 100 % forever, and an alarm that never clears is worse than none. Google is the exception,
because there every bucket belongs to a model — those are your quota, so they do count.

Want a specific model watched anyway? Build the automation on its own datapoint,
`limits.<window>.percent`.

---

## Troubleshooting

### An account delivers no data
Read `info.error` first — it names the cause in plain text. A rejected sign-in means signing in
again in the settings, or that the key is not an admin key (see Configuration). A service fault
or a missing connection is outside your instance and clears up by itself. The adapter log states
the same reason once and raises a single notification.

### A subscription says "not signed in" although you just signed in
Save the settings first, then sign in — the row needs a saved account to attach the sign-in to.
After a successful sign-in the adapter queries the account immediately, so values appear within
seconds.

### The object tree changed after updating to 0.3.0
Accounts now live under fixed ids (`claude`, `chatgpt`, `gemini`, `<name>-api`) and the separate
`auth` branch is gone — the sign-in state moved into `<account>.info.signedIn`. Old nodes are
removed automatically, and an existing Claude sign-in is carried over.

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 0.5.0 (2026-08-26)

- Changed: Each account now has two status datapoints instead of six — an offline marker ioBroker actually shows, and the reason in plain text. The retired ones are deleted on start
- New: The settings page shows every switched-on account as online, limited or offline at a glance, with the full reason in plain text when you hover the badge
- Changed: The names of the total and per-account limit datapoints now say "plan-wide", matching what they have actually counted since 0.4.0

### 0.4.0 (2026-08-26)

- Fixed: A limit that belongs to a single model no longer reports the whole account as full, and the warning names the window it came from instead of just "usage"
- New: Each account shows whether the AI service itself is online, telling a service outage apart from a rejected sign-in or a missing internet connection
- New: Error reporting via Sentry — crashes reach the developer automatically, but only if you enabled diagnostics and error reporting in the ioBroker system settings
- Changed: New adapter icon — a network of nodes instead of the dark tile, so it reads as AI at a glance and sits cleanly in both the light and the dark admin

### 0.3.0 (2026-08-26)

- New: ChatGPT and Google/Gemini subscriptions can now be monitored like the Claude one — each with its own guided sign-in that the settings page walks you through step by step
- New: The ChatGPT and Gemini readouts use the same endpoints the providers' own tools use, but no live subscription was available to test them on — please report anything that looks wrong
- Changed: Each account now owns exactly one node in the object tree (`claude`, `chatgpt`, `gemini`, `<name>-api`); the separate sign-in branch is gone and old nodes are cleaned up automatically
- Fixed: After signing in, the account is queried immediately instead of waiting for the next poll — no restart needed
- Fixed: OpenAI and Anthropic rows now state that they need an organisation admin key, instead of failing with an unexplained rejection

### 0.2.0 (2026-08-26)

- Changed: Completely new settings page — your stored AI credentials appear as simple on/off switches instead of a table, and new keys are picked up straight from the admin credential storage
- Fixed: The Claude subscription sign-in works reliably now — a guided card with live status, and the sign-in link stays valid until it is used instead of regenerating while you type

### 0.1.0 (2026-08-25)

- New: First release — reads usage limits, credits and costs of your Claude, OpenAI, Anthropic, OpenRouter and DeepSeek accounts into datapoints, with one warning at your chosen threshold

[Older changelogs can be found there](CHANGELOG_OLD.md)

## Support

- [ioBroker Forum](https://forum.iobroker.net/)
- [GitHub Issues](https://github.com/krobipd/ioBroker.ai-usage/issues)

### Support Development

This adapter is free and open source. If you find it useful, consider buying me a coffee:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=for-the-badge&logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg?style=for-the-badge)](https://paypal.me/krobipd)

---

## License

MIT License

Copyright (c) 2026 krobi <krobi@power-dreams.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

*Developed with assistance from Claude.ai*

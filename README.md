# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.ai-usage@main/admin/ai-usage.svg?v=4" width="48" align="top" /> ioBroker.ai-usage

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.ai-usage)](https://www.npmjs.com/package/iobroker.ai-usage) ![stable](https://iobroker.live/badges/ai-usage-stable.svg) ![Installations](https://iobroker.live/badges/ai-usage-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.ai-usage)](https://www.npmjs.com/package/iobroker.ai-usage)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.ai-usage/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.ai-usage/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Sentry](https://img.shields.io/badge/error%20reporting-Sentry-362d59?logo=sentry&logoColor=white)](https://github.com/ioBroker/plugin-sentry#plugin-sentry)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Monitors usage, limits and costs of your AI accounts — the Claude, ChatGPT and Google
subscriptions plus OpenRouter, DeepSeek, OpenAI and Anthropic API accounts. Needs ioBroker Admin 8.

---

## Features

- **One node per account** — limit windows with percent and reset time, credits, costs and tokens, named the same way for every provider
- **Totals** — summed costs, the highest utilisation of any account, and one trigger for automations
- **Warn threshold per account** — one notification when an account crosses it
- **Three subscriptions** — Claude, ChatGPT and Google, signed in with your own account; the settings page walks you through each step
- **Central credentials** — API keys come from the admin's credential storage, shared with the admin AI assistant
- **Online status** — the connection icon you know from every device, plus the reason in plain text
- **Read-only** — the adapter only reads; it never calls or configures an AI service
- **Object names in eleven languages** — the tree reads in your ioBroker language, not just English
- **Throttle-safe** — a minimum interval and automatic backoff keep the provider from locking your account

---

## Sentry / Error reporting

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Reporting is active by default. It stays off when the ioBroker diagnostics setting is `none` (`diag` in the system configuration), when data reporting is disabled for this instance or its host (`disableDataReporting`), and on CI systems. A report contains the error with its stack trace and technical context such as versions and platform, plus an anonymous installation ID.

For details and how to disable it, see the [Sentry plugin documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry). Error reporting requires js-controller 3.0 or newer.

---

## Requirements

- Node.js >= 22
- ioBroker js-controller >= 7.2.2
- **ioBroker Admin >= 8.0.11** — the adapter uses the admin's central credential storage

> The adapter CANNOT be installed via GitHub: The adapter must be installed via the ioBroker repository (stable or latest).

---

## Configuration

The instance settings show one list of AI accounts. Switch on what you want to monitor.

| Account                                                                       | How it is connected                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Claude](https://claude.ai) subscription**                                  | Open the sign-in page, log in, copy the code shown there and paste it back                                                                                                                              |
| **[ChatGPT](https://chatgpt.com) subscription**                               | The adapter shows a short code; type it on the OpenAI page it links to. The settings page notices by itself. Your Codex CLI session is not touched                                                      |
| **[Google Gemini](https://gemini.google.com) subscription**                   | Open the sign-in page and log in. Google sends the result to `localhost`, so **your browser shows an error page — that is expected**. Copy the **whole address** from the address bar and paste it back |
| **[OpenRouter](https://openrouter.ai), [DeepSeek](https://www.deepseek.com)** | Pick the stored key from the admin's credential storage                                                                                                                                                 |
| **[OpenAI](https://openai.com), [Anthropic](https://www.anthropic.com)**      | Needs an **admin key** of your organisation, not the key the admin assistant uses. A personal account without an organisation cannot deliver these reports at all — use the Claude subscription instead |

The three subscription endpoints are **not officially documented**; they are the ones those
providers' own tools use and can change without notice. Only the Claude subscription was tested
against a real account; ChatGPT, Google, OpenRouter, DeepSeek and the OpenAI and Anthropic
organisation reports are built from the providers' references and never ran against a real
account — please open an issue if something looks wrong.

| Option            | Description                                                                                          | Default |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ------- |
| **Warn at %**     | Per account: one notification when a plan-wide limit window crosses this utilisation                 | 80      |
| **Poll interval** | How often each account is queried, 60–3600 seconds. The floor keeps the provider from throttling you | 300     |
| **Notifications** | One notification on threshold crossing or broken credentials                                         | on      |

---

## State Tree

```
ai-usage.0.
├── info.connection            — at least one account is delivering data (bool)
├── total.                     — totals across all accounts
│   ├── costs.today/month/…    — summed real money (same currency only)
│   ├── maxLimitPercent        — highest utilisation of any account (limit window or budget)
│   ├── warningsActive         — accounts above their threshold
│   ├── limitReached           — an account is at 100 % (automation trigger)
│   ├── accountsReachable      — accounts currently delivering data
│   └── accounts               — configured accounts
├── claude / chatgpt / gemini  — one node per subscription
│   ├── warning                — this account is above its warn threshold (bool)
│   ├── limitReached           — this account is at 100 % (bool)
│   ├── info.unreach           — account is not delivering (bool) — drives the connection icon
│   ├── info.error             — why there is no data; empty while all is well, "Unknown" while the adapter itself has nothing to report
│   ├── info.lastUpdate        — when the current values were fetched
│   ├── limits.<window>.*      — percent, reset time and whether this window is the limit in force
│   └── credits.*              — where the provider reports a balance
└── <name>-api                 — one node per key-based account
    ├── warning / limitReached — same triggers as above
    ├── info.*                 — same three status states as above
    ├── credits.* / costs.*    — granted budget and real money
    ├── tokens.*               — token counters
    └── models.<model>.*        — tokens per model, where the report carries them
```

Only what an account's source actually delivers is created — and once created, a datapoint stays:
the reset time simply empties while no window is running, and a window or model disappears from the
tree only when the provider stops reporting it entirely.

**The connection icon** sits next to each account, green while it delivers. A throttle keeps it
green — the last values stay valid while the adapter waits. A rejected sign-in, a broken service or
an answer that cannot be processed switch it off at once, an unreachable service after three
attempts, so a hiccup does not make it flap. `info.error` names the cause whenever the provider gave
one, in the provider's own words where it sent any.

**Signing out clears that account's alarms.** Its measured values stay in the tree, but `warning`,
`limitReached` and every total that counts them drop it — an account nobody watches must not keep an
automation waiting.

**Which window is in force** is shown per window: with Claude the provider says so itself, elsewhere it
is the window that speaks for the account. It tells you what you will run into next — a model window
can be the one in force while your session and week are nearly empty. It never raises the warning.

**Only plan-wide windows raise the warning** — your session and your week — and the message names
the window it came from. A window belonging to a single model keeps its own datapoints but stays
out of it: a model you never use can sit at 100 % forever, and an alarm that never clears is worse
than none. Google is special: its quota pools are the plan-wide windows where it reports them;
otherwise its per-model buckets are the plan, the fullest speaks for the account and the warning
names that model. To watch one model anyway, build the automation on
its own `limits.<window>.percent`.

**A nearly spent budget counts the same way.** Where a provider reports a granted budget, it
competes with the time windows and the higher of the two speaks for the account — money that is
gone blocks it just as hard as a full window. The warning says which of the two it is.

---

## Troubleshooting

### An account delivers no data

Read `info.error` — it names the cause. A rejected sign-in means signing in again in the settings,
or that the key is not an organisation admin key. A service fault or a missing connection is
outside your instance and clears up by itself. The log states the same reason once.

`Unknown` there means the adapter itself has nothing to report — it is switched off, or it has just
started and has not asked yet.

### A subscription says "not signed in" although you just signed in

Save the settings first, then sign in — the row needs a saved account to attach the sign-in to.
After a successful sign-in the account is queried immediately, so values appear within seconds.

### A key row in the settings says its stored key is missing

The key was deleted from the admin's credential storage. Switch the account off, or add the key
again under Settings → Credentials — the adapter picks up a changed or new key while it runs.

### A subscription asks you to sign in again although it worked yesterday

The provider rejected the stored sign-in — a refresh token that was revoked or expired. The row says
so instead of pretending to be connected; signing in again is all it takes.

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
-->

### **WORK IN PROGRESS**

- Fixed: ChatGPT limits of a single model (such as GPT-5.3-Codex-Spark) were never shown — each now gets its own 5-hour and weekly window
- Fixed: An OpenRouter key with a monthly limit counted its whole lifetime spend against that limit and could stay at "limit reached" for good
- Changed: OpenRouter `credits.used` now shows the use in the running limit period; the lifetime spend stays in `costs.total`, so the history jumps once
- New: OpenRouter spend today and this month, with a month-end projection, now also counted in the cost totals
- Fixed: Claude extra usage billed in euros was counted as dollars in the cost totals — it now keeps the account's own currency
- Fixed: Alarms of an account stayed on for good when its API key was removed, or when the last account was switched off
- Fixed: After a restart the totals no longer drop to 0 for a moment, and `total.limitReached` no longer flips while the first query fails
- Fixed: Last month's costs of an account that stopped delivering no longer stay in this month's totals
- Fixed: A model limit alone no longer raises the account's warning when the plan-wide windows are still unused
- Fixed: Signing out now clears the account's alarms at once instead of with the next query
- Fixed: The ChatGPT sign-in no longer breaks off while you are still typing the code
- New: The adapter picks up a key that was changed or deleted in the credential storage while it runs
- New: A workspace stopped by its used-up credits or its spend control counts as "limit reached" for ChatGPT
- New: Google's plan-wide quota pools (5-hour and weekly) are shown where Google reports them, and they decide the account's warning
- Improved: `info.error` says why a key account has no key — none selected, deleted from the storage, or holding no key
- Improved: Google accounts without a Code Assist project show Google's own reason, and a refused quota query no longer reports a rejected sign-in
- Fixed: An Anthropic organisation account no longer fails for the whole 1st of every month
- Fixed: The settings page no longer spins forever when the instance does not answer, and shows a key row whose stored key is gone
- Fixed: Copying the sign-in code or link now works on plain http:// as well
- Improved: Several notifications of different accounts are kept instead of the newest replacing the previous one
- Improved: After a throttle the next query waits as long as the provider asks, instead of retrying too early
- Fixed: An instance stopped during its start no longer overwrites the stopped state of its accounts afterwards

Only the Claude subscription runs against a real account here. The ChatGPT, OpenRouter, Google,
DeepSeek and organisation changes follow the providers' references and their own tools' sources
and are covered by tests, but were not seen on a real account.

### 0.15.0 (2026-09-16) — stable

- Fixed: Model channels of an organisation account no longer vanish at the turn of a month — a model with no usage yet was deleted with its history and re-created on its next use
- Fixed: Stopping the instance right after it started no longer leaves the accounts showing as connected while the instance is switched off
- Fixed: Failures that reached the log, the `info.error` datapoint and Sentry as `[object Object]` now name the actual error
- Improved: A provider answer that keeps growing can no longer push the adapter towards running out of memory — it is cut off and reported as a service fault

The month-boundary fix concerns OpenAI organisation accounts, which have no real account here; it is
covered by tests and by the counter-test that limit windows are still cleaned up.

### 0.14.0 (2026-09-15)

- Fixed: A failed write of the token file after a refresh lost the sign-in for good — the provider had already rotated them, so the next poll reported a rejected sign-in
- Fixed: Signing out no longer comes undone by itself — a sign-out that landed during a background token renewal could leave the account signed in
- Fixed: The last-update stamp moved forward on a tolerated connection failure, dating values the round had never fetched
- Fixed: An answer the adapter cannot process is reported as a service fault at once, instead of claiming for three rounds that the service is unreachable
- Fixed: A failed cleanup of vanished windows or models no longer discards the round — the values were in the tree, but the account called them unstored and the totals froze
- Fixed: A connection failure counter that a throttle or a rejected sign-in had interrupted no longer adds up to "not reachable"
- Fixed: An account you signed out of drops its warning and limit alarms and leaves the adapter-wide totals — its measured values stay in the tree
- Fixed: The reset time of the Claude session and week windows is filled from the plan-wide block when the window entry itself carries none
- Improved: Window reset times, the next voucher expiry and the credit ceiling are written only when they change — announced facts, not measurements, so their timestamp stops moving every poll
- Improved: Where a provider sends a reason of its own, `info.error` now says it ("invalid API key") instead of a bare status number
- Improved: An access token the provider invalidated early is refreshed once and the request repeated, instead of reporting a rejected sign-in until it would have expired

Only the Claude subscription runs against a real account here. The token-file fix, the early-refresh
retry and the sign-out behaviour are covered by tests but were not seen on a real ChatGPT, Google,
OpenRouter, DeepSeek, OpenAI or Anthropic account.

### 0.13.0 (2026-09-12)

- Fixed: The costs of an Anthropic organisation account were a hundred times too high — the provider counts them in cents, the adapter read them as dollars
- Fixed: The same error was in the adapter-wide cost totals
- Fixed: An account whose values could not be written to the object database kept reporting itself as delivering, with a last-update stamp that went on moving
- Fixed: An answer still waiting on the object database during shutdown could mark accounts online again afterwards, or delete objects
- Fixed: An answer in a shape the adapter does not recognise now counts as a service fault, instead of reading as "this account has nothing"
- Fixed: Limit windows and model channels are no longer deleted when a single answer says nothing about them
- Fixed: Token counters of an organisation account show 0 after UTC midnight instead of keeping yesterday's numbers
- Fixed: Restarting the instance above the warn threshold no longer raises the warning and the notification again
- Fixed: The "limit reached" total now counts a window the provider has closed, the way each account already did
- Fixed: A configured account row the adapter cannot use now says so in the log instead of disappearing
- Improved: The "active window" and DeepSeek "available" flags are written only when they actually change, so their timestamp stops moving on every poll
- Improved: The ChatGPT voucher inventory is fetched about once an hour instead of every poll, halving that account's requests
- Improved: The settings page shows a finished device-code sign-in right away instead of up to half a minute later
- Improved: The provider table now says that Anthropic's cost report leaves out Priority Tier spend, so an organisation on that tier really spends more than the figures show

### 0.12.1 (2026-09-07)

- Fixed: The last-update stamp of an account no longer moves forward while the provider is only throttling — it dates the values standing next to it, so you can see how old they really are
- Improved: Twenty-five more datapoints explain themselves in the object tree — what "today" means (the provider counts it in UTC), and why the cost totals can be lower than the accounts show

### 0.12.0 (2026-09-06)

- Fixed: An account that has not been signed in yet no longer reports a rejected sign-in — no warning, no notification, and the settings page keeps offering the sign-in button
- Fixed: An account whose API key is missing or unreadable is now shown as not delivering, instead of leaving its old values standing as though they were current
- Fixed: An answer arriving while the adapter shuts down can no longer mark an account as online again after the shutdown wrote it offline
- Fixed: A throttled account counts as delivering everywhere now — the connection icon and the "reachable accounts" total no longer contradict each other
- Fixed: A limit the provider reports as empty is no longer shown as 0 % used, and a Google quota without a value no longer reads as completely used up
- Fixed: A rejected ChatGPT sign-in now says so at once instead of leaving you waiting for a quarter of an hour, and a Google account keeps delivering when one route is unavailable
- Fixed: A Google account without an AI subscription says so, instead of asking for a sign-in that cannot change the answer
- New: Every limit window shows whether it is the limit currently in force — with Claude the provider states it, elsewhere it is the window that speaks for the account
- Improved: An account is reported as at its limit when the provider says the window is closed, not only when the percentage happens to reach 100
- Improved: A window's reset time is written to the minute, so a recording of it no longer gains an entry on every single query, only on real changes
- Improved: An account that is delivering again says so in the log, instead of leaving the warning about its outage standing as the last word on it
- Improved: The settings page no longer asks the adapter for every status every four seconds — the values now arrive on their own as they change
- Changed: "Balance sufficient for calls" now sits under credits, where it belongs; the datapoint at the old place is removed automatically
- Changed: Each account node shows the readable provider name instead of the internal one — "Claude Max (Claude)" instead of "Claude Max (claude-sub)"
- Fixed: A per-model folder is now named in your ioBroker language as well, instead of carrying the provider's bare model identifier as its only name
- New: The datapoints whose meaning is not obvious from their name now carry a short explanation in eleven languages, shown in the object tree

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

_Developed with assistance from Claude.ai_

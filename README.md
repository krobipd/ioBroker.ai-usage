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

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Reporting only happens if you have enabled error reporting in the ioBroker diagnostics (**System settings → Diagnostics and error reporting**). Only an anonymous installation ID is transmitted — no name, e-mail address or IP address.

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
providers' own tools use and can change without notice. Claude was tested against a live
subscription, ChatGPT and Google could not be — please open an issue if something looks wrong.

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
│   ├── info.lastUpdate        — time of the last successful read
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
green — the last values stay valid while the adapter waits. A rejected sign-in or a broken service
switch it off at once, an unreachable service after three attempts, so a hiccup does not make it
flap. `info.error` names the cause whenever the provider gave one.

**Which window is in force** is shown per window: with Claude the provider says so itself, elsewhere it
is the window that speaks for the account. It tells you what you will run into next — a model window
can be the one in force while your session and week are nearly empty. It never raises the warning.

**Only plan-wide windows raise the warning** — your session and your week — and the message names
the window it came from. A window belonging to a single model keeps its own datapoints but stays
out of it: a model you never use can sit at 100 % forever, and an alarm that never clears is worse
than none. Google reports no plan-wide window at all, so there the fullest model window speaks for
the account and the warning names that model. To watch one model anyway, build the automation on
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

### A subscription asks you to sign in again although it worked yesterday

The provider rejected the stored sign-in — a refresh token that was revoked or expired. The row says
so instead of pretending to be connected; signing in again is all it takes.

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

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

### 0.11.0 (2026-09-05)

- Fixed: Signing in from the instance settings works again — a leftover setting from an earlier version had silently closed the adapter's message channel, so none of the three flows reached it
- Fixed: A subscription whose stored sign-in was rejected no longer claims to be signed in — the row now offers the sign-in again instead of showing a green check next to an error
- Fixed: The status badge of an account no longer blanks out for a moment when a single status read is missed — a hiccup in the settings page is not an account without a status
- Fixed: A stored credential whose name sorts high in the alphabet is no longer missing from the account list in the instance settings
- Fixed: The settings page falls back to English for a browser language the adapter does not ship, instead of passing that language on unchecked
- Improved: All object names are now available in eleven languages instead of English only, and a renamed object reaches installations that already exist
- Improved: ChatGPT usage is read with the identity that endpoint expects, the way the Claude query already did — fewer rejected requests on that account
- Improved: Monthly cost reports can no longer be cut short in silence — a report that does not fit is reported in the log instead of producing a figure that is too low
- Changed: "Highest account utilisation" says what it always measured — the fullest limit window **or** the account's remaining budget

### 0.10.0 (2026-09-01)

- Fixed: The reset-time datapoint of a limit window no longer disappears and reappears — it stays and simply empties while no window is running
- Fixed: The settings page no longer shows the sign-in screen to a signed-in account, and its rows load without waiting for the credential storage scan
- Improved: Claude usage is read with far fewer rejections — the query now identifies itself the way the endpoint expects
- Changed: New Claude sign-ins request only the profile permission — the stored access can no longer create API keys or run models
- New: ChatGPT accounts show their purchasable limit-reset credits — how many are available and when the next one expires
- Improved: An unreadable provider answer is now reported as a service fault instead of a missing connection

### 0.9.3 (2026-08-27)

- Fixed: The first start after updating no longer leaves a warning in the log

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

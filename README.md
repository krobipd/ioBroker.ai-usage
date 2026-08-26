# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.ai-usage@main/admin/ai-usage.svg" width="48" align="top" /> ioBroker.ai-usage

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.ai-usage)](https://www.npmjs.com/package/iobroker.ai-usage) ![stable](https://iobroker.live/badges/ai-usage-stable.svg) ![Installations](https://iobroker.live/badges/ai-usage-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.ai-usage)](https://www.npmjs.com/package/iobroker.ai-usage)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.ai-usage/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.ai-usage/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Monitors your AI accounts in ioBroker: usage windows, limits, credits and costs of
Claude, OpenAI, OpenRouter and DeepSeek as clean datapoints — for
dashboards, history and automations ("send a message at 90 % of the weekly limit").

---

## Features

- **Per-account monitoring** — one device node per AI account with harmonised datapoints: limit windows (percent + reset time), credits, costs and tokens
- **Totals** — summed costs, the highest limit utilisation across all accounts, and one `limitReached` trigger for automations
- **Warn threshold per account** — a single notification when an account crosses its threshold
- **Central credentials** — API keys live in the admin's central credential storage and are shared with the admin AI assistant
- **Read-only by design** — the adapter only reads usage data; it never calls, configures or writes to any AI service
- **Throttle-safe polling** — a hard minimum interval and automatic backoff protect your accounts from provider rate-limit lockouts

---

## Requirements

- Node.js >= 22
- ioBroker js-controller >= 7.2.2
- **ioBroker Admin >= 8.0.1** — the adapter uses the admin's central credential storage

---

## Configuration

The instance settings show your stored AI credentials (admin central storage, category AI) as
simple on/off switches — switch on what you want to monitor. The Claude subscription has its own
card with a guided sign-in: open the sign-in page, log in with your Claude account, paste the code,
done. New API keys are added once under Settings → Credentials and are shared with the admin AI
assistant.

| Option | Description | Default |
|--------|-------------|---------|
| **Warn at %** | Per account: one notification when a limit window crosses this utilisation | 80 |
| **Poll interval** | How often each account is queried (seconds) | 300 |
| **Notifications** | One notification on threshold crossing or broken credentials | on |

---

## State Tree

```
ai-usage.0.
├── info.connection            — at least one account reachable (bool)
├── total.                     — totals across all accounts
│   ├── costs.*                — summed real money (same currency only)
│   ├── maxLimitPercent        — highest window utilisation of any account
│   ├── warningsActive         — number of accounts above their threshold
│   └── limitReached           — any window full (automation trigger)
└── <account>.                 — one device per configured account
    ├── info.*                 — provider, reachable, last update
    ├── limits.<window>.*      — percent + reset time (session, week, per model, …)
    ├── credits.*              — granted budget: used / limit / remaining / percent
    ├── costs.*                — real money: today / month / projected
    └── tokens.*               — token counters (API accounts)
```

Only what an account's source actually delivers is created.

---

## Troubleshooting

### An account shows `reachable = false`
Check the credential in the admin's central credential storage (Settings → Credentials)
and the adapter log. Authentication errors raise one notification with the reason.

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 0.2.0 (2026-08-26)

- Changed: Completely new settings page — your stored AI credentials appear as simple on/off switches instead of a table, and new keys are picked up straight from the admin credential storage
- Fixed: The Claude subscription sign-in works reliably now — a guided card with live status, and the sign-in link stays valid until it is used instead of regenerating while you type

### 0.1.0 (2026-08-25)

- New: First release — reads usage limits, credits and costs of your Claude, OpenAI, Anthropic, OpenRouter and DeepSeek accounts into datapoints, with one warning at your chosen threshold

### 0.0.1 (2026-08-25)

- Initial development version

---

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

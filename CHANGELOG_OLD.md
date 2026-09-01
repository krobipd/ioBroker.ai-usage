# Older Changelog — ioBroker.ai-usage

Older changelog entries are moved here by the release tooling once the README list grows too long.
## 0.8.0 (2026-08-27)

- Fixed: A switched-off instance no longer leaves its accounts standing green in the object tree — every account is marked as not delivering when the adapter stops
- Fixed: Signing out of a subscription now really stops it — the adapter kept polling with what it still held in memory, and the next token refresh even restored the deleted sign-in
- Fixed: A restarted adapter no longer shows every account as offline until its first answer arrives, complete with struck-through icon and a red badge in the settings
- Fixed: From the second round on, all accounts queried at the same moment instead of spread out, which is exactly what makes a provider throttle or lock an account
- Fixed: Limit windows and models a provider stops reporting are now removed instead of staying in the object tree forever, frozen on their last value
- Fixed: Signing in no longer risks signing the subscription straight back out, which could happen when the immediate first query collided with a scheduled one
- Fixed: Google accounts are now spoken for by their fullest model quota, and the warning names that model — before, every single model could raise the account's alarm
- Fixed: "Configured accounts" counts what you switched on, including accounts whose credential could not be read; the sign-in button no longer hangs for up to 15 seconds
- Fixed: A damaged or unreadable stored sign-in now says so in the log instead of looking exactly like "never signed in"

## 0.7.1 (2026-08-27)

- Fixed: Restarting the adapter no longer writes one unchanged value into every status datapoint, so a recorded history stays free of restart noise

## 0.7.0 (2026-08-27)

- New: One log line after a change tells you how many datapoints the object tree gained and lost, instead of leaving you to click through the tree
- Fixed: A started sign-in that sat unused for a quarter of an hour now says so plainly instead of failing later with the provider's own cryptic answer
- Fixed: Datapoints that only repeat their previous value are no longer rewritten every cycle, which kept flooding the history of anyone recording them

## 0.6.0 (2026-08-26)

- New: Each account now shows the connection icon in the object tree — green while it delivers, struck through when it does not, exactly like every other ioBroker device

## 0.5.0 (2026-08-26)

- Changed: Each account now has two status datapoints instead of six — an offline marker and the reason in plain text. The retired ones are deleted on start
- New: The settings page shows every switched-on account as online, limited or offline at a glance, with the full reason in plain text when you hover the badge
- Changed: The names of the total and per-account limit datapoints now say "plan-wide", matching what they have actually counted since 0.4.0

## 0.4.0 (2026-08-26)

- Fixed: A limit that belongs to a single model no longer reports the whole account as full, and the warning names the window it came from instead of just "usage"
- New: Each account shows whether the AI service itself is online, telling a service outage apart from a rejected sign-in or a missing internet connection
- New: Error reporting via Sentry — crashes reach the developer automatically, but only if you enabled diagnostics and error reporting in the ioBroker system settings
- Changed: New adapter icon — a network of nodes instead of the dark tile, so it reads as AI at a glance and sits cleanly in both the light and the dark admin

## 0.3.0 (2026-08-26)

- New: ChatGPT and Google/Gemini subscriptions can now be monitored like the Claude one — each with its own guided sign-in that the settings page walks you through step by step
- New: The ChatGPT and Gemini readouts use the same endpoints the providers' own tools use, but no live subscription was available to test them on — please report anything that looks wrong
- Changed: Each account now owns exactly one node in the object tree (`claude`, `chatgpt`, `gemini`, `<name>-api`); the separate sign-in branch is gone and old nodes are cleaned up automatically
- Fixed: After signing in, the account is queried immediately instead of waiting for the next poll — no restart needed
- Fixed: OpenAI and Anthropic rows now state that they need an organisation admin key, instead of failing with an unexplained rejection

## 0.2.0 (2026-08-26)

- Changed: Completely new settings page — your stored AI credentials appear as simple on/off switches instead of a table, and new keys are picked up straight from the admin credential storage
- Fixed: The Claude subscription sign-in works reliably now — a guided card with live status, and the sign-in link stays valid until it is used instead of regenerating while you type

## 0.1.0 (2026-08-25)

- New: First release — reads usage limits, credits and costs of your Claude, OpenAI, Anthropic, OpenRouter and DeepSeek accounts into datapoints, with one warning at your chosen threshold

## 0.0.1 (2026-08-25)

- Initial development version

---

# Older Changelog — ioBroker.ai-usage

Older changelog entries are moved here by the release tooling once the README list grows too long.
## 0.11.0 (2026-09-05)

- Fixed: Signing in from the instance settings works again — a leftover setting from an earlier version had silently closed the adapter's message channel, so none of the three flows reached it
- Fixed: A subscription whose stored sign-in was rejected no longer claims to be signed in — the row now offers the sign-in again instead of showing a green check next to an error
- Fixed: The status badge of an account no longer blanks out for a moment when a single status read is missed — a hiccup in the settings page is not an account without a status
- Fixed: A stored credential whose name sorts high in the alphabet is no longer missing from the account list in the instance settings
- Fixed: The settings page falls back to English for a browser language the adapter does not ship, instead of passing that language on unchecked
- Improved: All object names are now available in eleven languages instead of English only, and a renamed object reaches installations that already exist
- Improved: ChatGPT usage is read with the identity that endpoint expects, the way the Claude query already did — fewer rejected requests on that account
- Improved: Monthly cost reports can no longer be cut short in silence — a report that does not fit is reported in the log instead of producing a figure that is too low
- Changed: "Highest account utilisation" says what it always measured — the fullest limit window **or** the account's remaining budget

## 0.10.0 (2026-09-01)

- Fixed: The reset-time datapoint of a limit window no longer disappears and reappears — it stays and simply empties while no window is running
- Fixed: The settings page no longer shows the sign-in screen to a signed-in account, and its rows load without waiting for the credential storage scan
- Improved: Claude usage is read with far fewer rejections — the query now identifies itself the way the endpoint expects
- Changed: New Claude sign-ins request only the profile permission — the stored access can no longer create API keys or run models
- New: ChatGPT accounts show their purchasable limit-reset credits — how many are available and when the next one expires
- Improved: An unreadable provider answer is now reported as a service fault instead of a missing connection

## 0.9.3 (2026-08-27)

- Fixed: The first start after updating no longer leaves a warning in the log

## 0.9.2 (2026-08-27)

- Fixed: Stopping the instance now marks the accounts as offline on installations that were updated too, not only on fresh ones — the previous version left them showing as online

## 0.9.1 (2026-08-27)

- Changed: While an account has nothing to report — the adapter switched off, or started and not asked yet — the reason now reads "Unknown" instead of a sentence about the adapter

## 0.9.0 (2026-08-27)

- Fixed: Switching the instance off now shows every account as offline in the object tree and the settings, instead of leaving them green for as long as the adapter is not running
- Fixed: After a crash or a hard kill an account no longer keeps claiming to deliver data; every account starts as "not delivering" until its first answer arrives

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

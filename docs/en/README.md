# ioBroker.ai-usage

Monitors usage, limits and costs of your AI accounts and writes them into read-only
ioBroker states. The adapter only **reads** — it never calls a model, never changes
anything at the provider, and never sends your data anywhere.

---

## What it can watch

| Account                                      | What you get                                                                                                                    | How it is connected                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Claude subscription** (Pro / Max)          | 5-hour and weekly limit windows with percent and reset time, per-model windows, extra-usage credits and the money spent on them | Sign in with your own Anthropic account: open the link, log in, paste the code back                                                                                                  |
| **ChatGPT subscription** (Plus / Pro, Codex) | 5-hour and weekly windows, additional per-surface windows, credit balance, purchasable limit-reset vouchers                     | The adapter shows a short code; you type it on the OpenAI page. Your own Codex CLI session is never touched                                                                          |
| **Google Gemini subscription** (Pro / Ultra) | The per-model quota buckets Google reports                                                                                      | Open the link and log in. Google redirects to `localhost`, so **your browser shows an error page — that is expected**. Copy the whole address from the address bar and paste it back |
| **OpenRouter**                               | Credits used, limit, remaining, percent                                                                                         | Pick the stored key from the admin's credential storage                                                                                                                              |
| **DeepSeek**                                 | Balance (granted and topped-up separately), and whether it still covers calls                                                   | Pick the stored key                                                                                                                                                                  |
| **OpenAI organisation**                      | Costs today and this month, month-end projection, today's tokens per model                                                      | Needs an **admin key** of your organisation                                                                                                                                          |
| **Anthropic organisation**                   | Costs today and this month, month-end projection, today's tokens                                                                | Needs an **admin key** of your organisation                                                                                                                                          |

The three subscription endpoints are the ones those providers' own tools use. They are
**not officially documented** and can change without notice. Claude was tested against a
live subscription; ChatGPT and Google are built from verified sources but were never run
against a real account — please open an issue if something looks wrong.

---

## Requirements

- Node.js >= 22
- ioBroker js-controller >= 7.2.2
- **ioBroker Admin >= 8.0.11** — the adapter reads API keys from the admin's central
  credential storage instead of asking for them again

---

## Setting it up

1. Install the adapter and open the instance settings.
2. The settings page shows **one list**: the three subscriptions first, then one row per
   AI key you stored under **Admin → Settings → Credentials**.
3. Switch on what you want to watch. Each row has its own **warn threshold** (10–100 %,
   default 80 %).
4. For a subscription, the sign-in area opens below its row and walks you through the
   flow that provider requires. **Save first** — the sign-in talks to the running
   instance.
5. After a successful sign-in the account is queried immediately; you do not have to wait
   for the next cycle.

### Options

| Option            | What it does                                                                                         | Default |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ------- |
| **Poll interval** | How often each account is queried, in seconds. Minimum 60 s                                          | 300 s   |
| **Notifications** | One ioBroker notification when an account crosses its warn threshold or its credentials stop working | on      |

Accounts are queried in a staggered order, and a provider that answers "too many
requests" puts that account into a growing backoff (10 minutes, doubling up to an hour)
while the last values stay in place.

---

## The object tree

One device node per account, named the same way for every provider:

```
ai-usage.0
├─ info.connection            at least one account is delivering data
├─ <account>                  e.g. claude, chatgpt, gemini, <name>-api
│  ├─ info.unreach            the offline marker; drives the icon in the object tree
│  ├─ info.error              why, in plain text; empty while everything works
│  ├─ info.lastUpdate         last successful query
│  ├─ warning                 above the account's warn threshold
│  ├─ limitReached            at 100 %
│  ├─ limits.<window>.percent      utilisation of a limit window
│  ├─ limits.<window>.resetAt      when it resets (empty while no window runs)
│  ├─ credits.*               used / limit / remaining / percent, granted / topped up
│  ├─ costs.*                 today / month / total / projected month-end
│  ├─ tokens.*                input and output tokens today
│  └─ models.<model>.*        per-model tokens and costs
└─ total
   ├─ costs.today / month / projectedMonth      summed over all USD accounts
   ├─ maxLimitPercent         the fullest account (limit window or budget)
   ├─ warningsActive          accounts above their threshold
   ├─ limitReached            any account at 100 %
   ├─ accountsReachable       accounts currently delivering
   └─ accounts                accounts you switched on
```

**Datapoints stay once they exist.** A provider that leaves a field out for a while does
not make its datapoint disappear; time stamps are written empty instead. Only a whole
limit window or model that the provider stopped reporting is removed, and switching an
account off removes its node completely.

**`total.costs` only sums real money in the same currency** — piece counters (request
credits, reset vouchers) and other currencies stay out on purpose.

---

## Warnings, and what speaks for an account

Only a **plan-wide** window can raise an account's warning. A per-model bucket gets its
own datapoints but never triggers the alarm: a model you never use can sit at 100 %
forever, and an alarm that never clears is worse than no alarm. Google is the exception —
it reports no plan-wide window at all, so there the fullest model bucket speaks for the
account, and the warning names the model.

The granted budget competes with the windows: an account whose money is nearly spent is
just as blocked as one whose time window is full. Whichever side is higher gives the
warning its label.

---

## Online status

`info.unreach` means **"this account is not delivering"** and drives the connection icon
next to the account in the object tree:

| Situation                                      | Icon                               | `info.error`                         |
| ---------------------------------------------- | ---------------------------------- | ------------------------------------ |
| Everything works                               | green                              | empty                                |
| Throttled by the provider                      | green — the last values still hold | says so, with the retry delay        |
| Sign-in rejected                               | red                                | "Sign-in rejected — …"               |
| The service reports a fault                    | red                                | "The AI service reports a fault — …" |
| Not reachable at all                           | red, after three attempts          | "Not reachable after N attempts — …" |
| Instance stopped, or started and not asked yet | red                                | `Unknown`                            |

---

## Privacy and credentials

- Subscription tokens belong to the adapter alone: they live encrypted in the instance
  data directory, owner-readable only. The adapter **never** reads or writes the files of
  your own tools (`~/.codex/auth.json`, `oauth_creds.json`) — those refresh tokens rotate,
  and two programs refreshing them would sign each other out.
- API keys are read from the admin's central credential storage and never copied.
- The Claude sign-in asks for the profile scope only — the token cannot create API keys
  or call models.
- The adapter talks to the AI providers and to nobody else.

---

## Troubleshooting

**The sign-in button does nothing / the row keeps spinning.**
Save the settings first, and make sure the instance is running — the sign-in is a
conversation with the running adapter.

**Google shows an error page after signing in.**
That is expected and the reason the flow works at all. Copy the **whole address** out of
the address bar and paste it into the field.

**"Not signed in" although you signed in.**
The stored sign-in was rejected by the provider (a revoked or expired refresh token). Sign
in again — the row tells you so instead of pretending to be connected.

**An OpenAI or Anthropic account delivers nothing.**
Those reports need an **organisation admin key**. A personal account without an
organisation cannot produce them at all; use the Claude subscription instead.

**Claude answers "too many requests".**
Raise the poll interval. The adapter identifies itself the way Claude's own tooling does
and backs off on its own, but a very short interval across several tools can still add up.

---

## Support

Questions, bugs and ideas: <https://github.com/krobipd/ioBroker.ai-usage/issues>

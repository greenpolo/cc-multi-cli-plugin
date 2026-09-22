# Usage and receipts

Run `/multi-usage` inside `claude-multi` to open the native Claude Mods usage
pane. It starts with an overview of all five providers. Select a provider for
quota, billing, and session token details; select **Receipts** for completed
worker and main-turn records. Use the buttons or left/right arrows to switch
views, up/down to scroll, **Refresh** or `r` to reload, and Escape to close.

| Provider | Account information in the menu |
| --- | --- |
| OpenAI / Codex | Native account quota windows, percent used, reset times, plan and credits when reported |
| Cursor | Account subscription usage percentages and billing-cycle resets, plus billed token totals and charged USD for this session's active native agents |
| OpenCode Zen | Go subscription quota windows and resets when entitled; prepaid balance and billed API spend require the billing console |
| Antigravity | Native account quota groups, remaining percentages, reset times, and AI credit balance when reported |
| Grok | Local login/renewal status; an access-token expiry is shown only without a refresh token. The CLI exposes no account quota, and local token presence does not prove the login remains accepted. |

Unavailable and disabled providers stay visible. Missing billing data is never
shown as a zero charge. The menu also shows session token counts for every
provider and keeps these separate from account quota and charges.

Opening or refreshing the pane performs read-only account lookups, without model
inference. Account results are cached for 30 seconds; Refresh requests fresh data.
A failed provider lookup does not prevent the others from displaying. The only
slash command is `/multi-usage`; receipts and billing live within its menu.

## Quota-aware model selection

The menu's **Quota-aware model selection** toggle enables an advisory hook for
the main agent in the current session. It is off by default. When enabled, the
agent receives current provider quota summaries from a `PreToolUse` hook on its
`Agent`/`Task` calls, before the subagent tool executes,
with guidance to prefer the least-used subscription among models suitable for
the task. It can still choose another model, and explicit user model requests
take precedence. The hook does not change worker arguments, block spawns, or wait
for quota resets.

Ordinary prompts, other tools, and nested workers do not trigger the advisory.
The model consumes the added context on its next inference; the hook does not
restart model selection for an already-issued spawn.

The advisory uses the same cached account lookups as the menu. Unavailable quota
is labeled unknown, and lookup failures do not stop the agent. Worker receipts
are not included in the advisory. Disabling the toggle stops future advisories;
earlier context already received by the agent is not removed. The preference is
session-only and is cleared when the session detaches.

Runtime totals cover requests observed by this gateway process; restarting the
launcher starts a new in-memory view. Claude subscription passthrough and reviewer
inference are not included in these totals.

## Saving receipts

Set `MULTI_RECEIPTS_FILE` to an existing directory's file path before launching:

```sh
MULTI_RECEIPTS_FILE="$PWD/usage.jsonl" claude-multi
```

In PowerShell:

```powershell
$env:MULTI_RECEIPTS_FILE = Join-Path $PWD "usage.jsonl"
claude-multi
```

The gateway appends one JSON line when a worker invocation or main turn finishes.
Each receipt includes a schema version, unique receipt ID, session and agent IDs,
invocation ID when available, timestamps, outcome, request count, and usage entries
grouped by provider, model, effort, endpoint or native transport, and count source.
Model or effort changes remain separate entries. Native SDK/CLI transports are
identified as `@cursor/sdk`, `agy`, and `grok`; their upstream URLs are not known to Multi.

Receipts contain no prompts, responses, tool arguments, or credentials. File errors
are reported on stderr without failing inference. A normal shutdown drains queued
writes and marks unfinished invocations incomplete. Abrupt process termination can
lose pending records; this is a local accounting aid, not an exactly-once billing
ledger. Use separate files per concurrent launcher process when collecting a fleet.

## Understanding the numbers

`source` distinguishes provider counts, local estimates, mixed counts, and missing
usage information. Failed or cancelled runs can have incomplete usage; zero recorded
tokens does not prove no tokens were consumed. Replaying a saved response does not
add another request's usage. Cache reads and writes remain separate from uncached
input. Reported reasoning tokens are informational and must not be added again to
output totals.

Cursor uses the SDK's per-run counters. Antigravity differences its native
cumulative counters across continuations. Estimates remain a fallback when native
counts are unavailable. These runtime counts do not establish a monetary charge.

Cursor billed usage in the menu is a separate, provider-owned view covering each native agent's
lifetime, potentially including previous launcher sessions. Local billing entries
are per turn, rather than gateway requests. Costs are in USD cents; missing cost
means not yet available, while a reported zero can represent included usage. Billing
may settle after a run ends, so query again later if needed. See the
[Cursor SDK documentation](https://cursor.com/docs/sdk/typescript#token-usage).

Codex quota comes from its native
[`account/rateLimits/read` interface](https://developers.openai.com/codex/app-server/).
Cursor subscription quota uses its native `DashboardService/GetCurrentPeriodUsage`
endpoint with the existing SDK login. This internal interface can change independently
of the public SDK. Its reported percentages are kept separate from per-agent charged
USD; raw plan allowance units are not assumed to be dollars.

Zen Go quota comes from `/zen/go/v1/usage` using the same API key as inference.
Go subscription allowance and the prepaid Zen wallet are different account data.
An account without Go entitlement has no Go quota to display; this does not mean
its prepaid balance is zero.

Antigravity quota comes from separate, read-only native CLI invocations:
`agy -p /usage --output-format json` and `agy -p /credits --output-format json`.
These use the same native login as workers and do not run model inference or send
commands into an active worker. Credits remain credits, with no assumed dollar
conversion. A failed credit lookup does not hide a successful quota lookup.
The third-party `antigravity-auth` package and its separate credential store are
not needed. See Google's [headless CLI documentation](https://antigravity.google/docs/cli/headless/).

Quota percentages and credit balances are not API dollar charges. Account snapshots
include activity outside this launcher. Changes between snapshots cannot establish
an individual worker's charge, especially when several workers share an account.

# Grok

Run the official Grok Build CLI (`grok`) as a native coding worker inside Claude Code.

## Setup

Install the plugin as described in [docs/installation.md](installation.md), then
sign in with the official flow:

```text
/multi-grok:login
```

From a checkout, the equivalent is `grok login` followed by a normal launch.
`--grok-models` prints the catalog. The gateway uses the CLI's own account
credential for inference. Multi's usage reader loads the native auth file to
check key and refresh-token presence and access-token expiry, but does not use
those credentials for direct inference or expose them in usage responses.
`XAI_API_KEY` is removed from the environment of
every run: an API key silently outranks the browser login and would move billing
from the subscription to metered xAI credit.

The CLI renews its own access token — measured at six hours — from a refresh
token it stores, and asks for a new sign-in periodically. `/multi-usage` reports
whether a renewable login is present rather than counting down that short clock,
and a failed run says to run `grok login`.

## Models

The picker reads the models advertised by `grok models`.

| Picker entry | Route |
| --- | --- |
| Advertised model | `multi/grok/<id>` |

`MULTI_GROK_MODELS` restricts the rows to a comma-separated list of advertised
IDs, leaving other providers unchanged. `/effort` accepts `low`, `medium`,
`high`, `xhigh`, and `max`; the CLI also supports `none` and `minimal`, which
have no Claude row and are refused explicitly. The model that answers is not
always the row's name — usage and receipts report the model the CLI billed.

Workers: the Agent tool's `Grok` type runs any row above; pass `model:
<id>` to pick one, or omit `model` to run the CLI's `(default)`-marked model.
Effort is never part of the model name; the session's `/effort` applies.

## Execution and permissions

Claude's permission mode and tool rules take precedence and travel with each
run; nothing is written to your Grok configuration and no global hook is
installed.

| Claude mode | Grok run |
| --- | --- |
| Auto | `--permission-mode auto` plus the rules below |
| acceptEdits | `--permission-mode acceptEdits` |
| Plan | `--permission-mode plan`, plus `Bash`, `Edit` and `Write` denied and the matching tools removed |
| Bypass | `--permission-mode bypassPermissions`, explicit restrictions retained |
| Default, dontAsk | `--permission-mode auto`, with a one-line notice |

With no Claude rule and outside Plan, the run passes no `--tools`, so Grok keeps every
tool it has, including ones a newer build adds. When a rule applies, restrictions are
expressed three times on purpose. The native toolset is bounded
with `--tools`, every ungranted tool is *also* removed by name, because the CLI
adds its own planning, feedback and media tools to an allowlist, and execution is gated with `--deny` rules whose syntax matches Claude
Code's own (`Bash(git:*)`, `Write(path)`, `MCPTool(*)`). Deny rules outrank every
mode, including Bypass. Their genres are coarser than the tool names — `Edit(*)`
also refuses the `write` tool — so a rule is only sent when none of the tools it
reaches was granted, and finer restrictions rely on the bounded toolset. Outside Plan,
Grok's own tools that no Claude tool maps to (subagents, scheduler, workflows, the
`search_tool`/`use_tool` MCP broker, media) stay available unless an explicit tool list
leaves them out. The interactive `ask_user_question` tool is always removed, since a
headless run has nobody to answer it.

Plan mode alone removes no native tool, so Multi reconstructs it with explicit
denials rather than trusting the flag. Claude rules with no native form are skipped
with a one-line notice. A run whose announced toolset shows the policy did not take
effect fails explicitly.

Each finished tool call is a row under Grok's own tool name (`read_file`,
`run_terminal_command`, ...) with its raw input and output, in the `/model` Grok
session or inside the Grok worker's transcript; refusals show as errored rows. New
names in an announced toolset are registered for later runs. Rows are never
replayed as executable Claude tools.
The transcript keeps streamed text and one closing summary of action counts,
changed files, and failed or refused actions. Multi adds no reviewer.

### Your MCP servers

Grok connects your configured MCP servers after a run starts, and they run in Auto
and Bypass. Multi denies their execution with `MCPTool(*)` only in Plan, under an
explicit tool list with no `mcp__` entry, or when a Claude rule denies any MCP tool
(Grok's rule has no measured per-server form, so the denial is coarse). The model still
sees the names; to hide them, remove the servers with `grok mcp`.

## What the provider is sent

The conversation is flattened into one native prompt behind a fixed preamble.
Claude's own `system` is never forwarded, and four of its system reminders are
dropped: the deferred tool catalogue, the MCP server catalogue, the skill
catalogue, and the subagent catalogue. They name capabilities this provider
cannot call and made up most of a measured prompt.

Every other reminder is forwarded, because it is an instruction addressed to
whoever answers the turn and the CLI reaches it no other way: the project's
`CLAUDE.md` and your own, the environment and repository context block, Auto Mode
notices, hook output, and recalled memories. The repository's `AGENTS.md` is not
sent, since the CLI reads it directly. A block Multi does not recognise is
forwarded rather than dropped — a renamed catalogue only costs tokens, a renamed
instruction block would cost the worker its rules.

Request identity ignores every reminder, forwarded or not, so a retry that only
carries a refreshed block is the same request and never pays for the turn twice.
A turn left empty by the filtering adds nothing, and a request with no content at
all fails explicitly.

## Continuation, caching and failures

State is isolated by Claude session, worker, provider, and canonical workspace.
The session identity is chosen by the gateway before the run starts and recorded
as soon as the CLI produces output, so a crash resumes the native conversation
instead of starting a fresh one. Follow-ups send only the newest turn after the
last assistant response, and outer history changes produce a notice and continue
on the native record. Native state is never rewound.

One turn runs at a time per worker and workspace. A different prompt sent while
a turn is running waits for it and then runs. A resent copy of the running request
(Claude Code retrying after a dropped connection) reattaches to the running turn
instead of starting the same native actions again.

A completed identical request replays its saved output. A run that ends without
a terminal event is never assumed complete: the next request resumes with an
interruption notice. An answer returned on a different native session is refused
rather than merged. Cost and token counts come from the run's own terminal event;
`grok usage <session>` reports the session total the CLI itself recorded. The CLI
also emits one `usage` event per model call before that terminal event, so the
Messages response reports the last call's input and cache reads (the live
context) in its standard fields and the terminal sums as `multi_usage.consumed_*`
with `model_calls` (the count of those events, or `num_turns` without them).

A failure that repeats on every attempt — a policy the CLI would not apply, a
missing binary, a denied path — is reported as a request error so the session
stops instead of paying for the same run again. A start the operating system
refused because the machine was momentarily out of processes, handles or memory
stays retryable: nothing ran, so nothing was billed.

## Paths per OS

| OS | Credential | Native sessions |
| --- | --- | --- |
| Linux and macOS | `~/.grok/auth.json` | `~/.grok/sessions/<encoded cwd>/<id>/` |
| Windows | `%USERPROFILE%\.grok\auth.json` | `%USERPROFILE%\.grok\sessions\<encoded cwd>\<id>\` |

Multi keeps its own harness records in a `multi-harness` directory beside them
and never rewrites the CLI's session files.

## Limits

One name differs between the two vocabularies: the shell is announced as
`run_terminal_command` but removed as `run_terminal_cmd`, and passing the
announced name is accepted in silence while the tool keeps running. Multi maps it
and verifies the result on every announcement.

Grok Build is an early beta: its flags and tool names can change between
releases, so the adapter checks the toolset the CLI announces on every run and
fails explicitly when a policy did not take effect. The CLI's sandbox profiles
rely on Landlock and Seatbelt and are unavailable on Windows; Multi does not use
them. Images, PDF attachments, strict output schemas, explicit tool choice and
stop sequences are not supported through this bridge.


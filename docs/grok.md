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

Workers: the Agent tool's `multi-grok` type runs any row above; pass `model:
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

Restrictions are expressed three times on purpose. The native toolset is bounded
with `--tools`, every ungranted tool is *also* removed by name — the allowlist
alone left nineteen tools for a twelve-tool request, the CLI adding its own
planning, feedback and media tools — and execution is gated with `--deny` rules whose syntax matches Claude
Code's own (`Bash(git:*)`, `Write(path)`, `MCPTool(*)`). Deny rules outrank every
mode, including Bypass. Their genres are coarser than the tool names — `Edit(*)`
also refuses the `write` tool — so a rule is only sent when none of the tools it
reaches was granted, and finer restrictions rely on the bounded toolset. Native subagents (`--disallowed-tools Agent`), dynamic
tool discovery (`search_tool`, `use_tool`) and the interactive `ask_user_question`
tool are always removed.

Plan mode alone removes no native tool, so Multi reconstructs it with explicit
denials rather than trusting the flag. Unsupported modes, untranslatable tool
restrictions, and an unenforced policy fail explicitly.

Each finished tool call is a row under Grok's own tool name (`read_file`,
`run_terminal_command`, ...) with its raw input and output, in the `/model` Grok
session or inside the Grok worker's transcript; refusals show as errored rows. New
names in an announced toolset are registered for later runs. Rows are never
replayed as executable Claude tools.
The transcript keeps streamed text and one closing summary of action counts,
changed files, and failed or refused actions. There is no Grok reviewer, and
Multi never borrows another provider's.

### MCP is denied, not hidden

Grok connects your configured MCP servers after a run starts, and no per-run flag
prevents it: with a two-entry allowlist and the dynamic discovery tools removed,
the announced toolset still grew from 2 entries to 65, all 63 additions being MCP
tools. Multi denies their execution with `MCPTool(*)`, a rule the CLI validates
and applies above every mode, but the model still sees those names. If you need
them out of sight, remove the servers from your Grok configuration with
`grok mcp`.

## What the provider is sent

The conversation is flattened into one native prompt behind a fixed preamble.
Claude's own `system` is never forwarded, and four of its system reminders are
dropped: the deferred tool catalogue, the MCP server catalogue, the skill
catalogue, and the subagent catalogue. They name capabilities this provider
cannot call, and on a measured session they were 72,704 characters of a 95,852
character prompt whose real message was 841.

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

One turn runs at a time per worker and workspace. An identical in-flight request
observes the existing exchange. A different request for that busy identity is
refused with an explicit error rather than queued behind it. Such
a prompt was written before the running turn answered, so its history stops at the
previous assistant message and resuming with it would send the running turn to the
CLI a second time. Multi never reruns a paid turn on a guess; send the prompt
again once the answer lands. Cursor and Antigravity refuse the same way.

A completed identical request replays its saved output. A run that ends without
a terminal event is never assumed complete: the next request resumes with an
interruption notice. An answer returned on a different native session is refused
rather than merged. Cost and token counts come from the run's own terminal event;
`grok usage <session>` reports the session total the CLI itself recorded.

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

# Cursor

Use Cursor's official SDK as a native coding worker inside Claude Code.

## Setup

Install the plugin as described in [docs/installation.md](installation.md), then
run `/multi-cursor:login` to complete Cursor's official SDK browser login. From a
checkout, run `node plugins/multi-core/src/launcher.ts --cursor-login`. The SDK
also accepts `CURSOR_API_KEY`; Cursor owns the credential and billing.
Base selections set `fast=false` when the account advertises that parameter. This
keeps Fast off unless an explicit Fast preset is selected.

## Models and workers

The launcher discovers the account catalog. `/model` shows these default Cursor
rows when available:

| Picker row | Route |
| --- | --- |
| Auto | `multi/cursor/default` |
| Grok 4.7 | `multi/cursor/grok-4.7` |
| Composer 2.5 | `multi/cursor/composer-2.5` |

Unavailable rows are omitted. `MULTI_CURSOR_EXTRA_MODELS` adds advertised
`selection.id` values. `--cursor-models` prints full routes.

Workers: the Agent tool's `Cursor` type runs any row above; pass `model:
<id>` (for example `model: composer-2.5`) to pick one, or omit `model` to run
the default, `default` (Auto). Full catalog routes, including parameter
presets (`multi/cursor/<id>/<params>`), remain callable through `/model
multi/cursor/<id>`, but a preset's parameters are not part of a worker model
and do not register a separate `Cursor` model.

## Execution

Cursor's SDK owns native tools, its system prompt, and conversation state. Each finished SDK tool call is a row under Cursor's tool type (`shell`,
`read`, `edit`, `grep`, ...) with its native arguments and output (stdout/stderr and
exit code, file content, diff), in the `/model` Cursor session or inside the Cursor
worker's transcript. The transcript also keeps streamed text, context-compaction
notices, and one closing summary of action counts, changed files, and failed or
denied actions. External actions are displayed and never replayed as executable
Claude tools. Cursor loads your own Cursor setup (its MCP servers, rules, hooks and
plugins) and keeps its subagents; Claude's deny rules remove the matching Cursor
tools, and Plan removes shell, edits, subagents, MCP and image generation.

Claude and OpenAI parents can spawn Cursor workers. Each worker has its own
SDK state. Worktree workers use their canonical workspace for SDK execution and
policy checks. Cancellation reaches the native SDK run.

## Permission modes

| Claude mode | Cursor behavior |
| --- | --- |
| Plan | Native plan mode with read, grep, glob, and directory-listing tools. Shell and edit capabilities are excluded. |
| Any other mode | Native agent mode, run as Bypass: the SDK's own Auto review stays off. Explicit tool restrictions and SDK sandbox settings still apply. |

Modes apply at prompt boundaries. Worker modes inherit from the parent and the
worker type's definition. Settings, plugin policies, tool lists, and managed
policy are admitted per operating system; see [docs/permissions.md](permissions.md).
Ask rules, sandbox settings and argument-specific
deny rules have no SDK form and are skipped with a one-line notice. The SDK runs with
isolated settings, so a `.cursor/permissions.json` is not loaded. SDK events provide native action observations for Claude
Mods display; Claude's classic tool hooks do not enforce native SDK tool calls.

## State and resume

SDK state persists per Claude session, worker, provider, and canonical workspace.
A state lock serializes ownership. Durable SDK run identifiers allow terminal-result
recovery through `Agent.getRun` without rerunning actions. If recovery cannot
confirm a terminal result, the session stays interrupted and the next request
streams an interruption notice before fresh work.

After a prior response, only the newest turn is forwarded: everything after the
last assistant message. A request without a new user message fails explicitly.
If outer history no longer contains the prior response, Claude receives a notice
and Cursor continues on its native record. Native state is never rewound.
Completed identical requests can replay their saved response.

Older (v2) gateway records are migrated without replacing the native Cursor agent;
the original file is kept. If a v2 and a v3 record name different
native agents, Multi refuses and names both files; keep the one whose conversation
should continue and move the other out of the state directory. At most 32 SDK agents are attached at once; idle ones are
released and resumed later from disk.

One turn runs at a time per worker and workspace. A different prompt sent while
a turn is running waits for it and then runs. A resent copy of the running request
(Claude Code retrying after a dropped connection) reattaches to the running turn
instead of starting the same native actions again.

## Compaction

Claude compaction can prepare a bounded summary with native tools disabled. The
summary is used only when its transcript prefix, instructions, worker, and policy
generation still match. It expires after two minutes; cancellation or a new
prompt invalidates it. Otherwise core compaction handles the transcript. This
process preserves the native SDK conversation and never rewinds it.

## Limits

Cursor-native child spawning is
disabled. The SDK exposes no public force-compaction or threshold control, manual
approval transport, arbitrary Claude-native tool cards, strict forced tool choice,
stop strings, PDF attachments, or per-response generation caps. Cursor turn
usage is reported when the SDK provides it; otherwise the Messages response
marks its local token estimate explicitly. The SDK reports usage once per run
(its `turn-ended` update and the run result), not per model call, so the
standard usage fields carry the run's sums rather than its last call's context,
and `model_calls` is not reported. Billed usage is queried separately,
on demand, and may lag while Cursor settles billing.

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

| Picker row | Route | Named worker |
| --- | --- | --- |
| Auto | `multi/cursor/default` | `cursor-default` |
| Grok 4.6 | `multi/cursor/grok-4.6` | `cursor-grok-4-6` |
| Composer 2.5 | `multi/cursor/composer-2.5` | `cursor-composer-2-5` |

Unavailable rows are omitted. `MULTI_CURSOR_EXTRA_MODELS` adds advertised
`selection.id` values. `--cursor-models` prints full routes and worker names.
Named workers follow the picker rows; full catalog routes remain callable through
`/model multi/cursor/<id>` and do not multiply worker registrations for presets.

## Execution

Cursor's SDK owns native tools, its system prompt, conversation state, and native
review. Claude Code displays streamed progress, tool status, elapsed time, shell
output, exit status, and bounded edit details. External actions are displayed and
never replayed as executable Claude tools. Cursor task, child-agent, and MCP
capabilities are disabled.

Claude and OpenAI parents can spawn named Cursor workers. Each worker has its own
SDK state. Worktree workers use their canonical workspace for SDK execution and
policy checks. Cancellation reaches the native SDK run.

## Permission modes

| Claude mode | Cursor behavior |
| --- | --- |
| Auto | Native agent mode with SDK Auto review requested. The SDK may proceed without classifier review when its classifier is unavailable. |
| Plan | Native plan mode with read, grep, glob, and directory-listing tools. Shell and edit capabilities are excluded. |
| Bypass | Native agent mode with Auto review disabled. Explicit tool restrictions and SDK sandbox settings still apply. |

Modes apply at prompt boundaries. Worker modes inherit from the parent and named
worker definitions. Settings, plugin policies, tool lists, and managed policy are
admitted per operating system; see [docs/permissions.md](permissions.md).
Unsupported modes, unknown workers, ignored Cursor permission files, ask rules,
sandbox policy, unsupported argument or path rules, and unsupported managed
controls fail explicitly. Claude hooks observe native runs but do not enforce
native SDK tool calls.

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

One turn runs at a time per worker and workspace. A prompt sent while a run is
in flight is refused with a deterministic error rather than queued behind it:
resuming a prompt whose history stops at the previous assistant message would
send the running turn to the SDK a second time. Multi never reruns a paid turn
on a guess; send the prompt again once the answer lands. Antigravity and Grok
refuse the same way.

## Compaction

Claude compaction can prepare a bounded summary with native tools disabled. The
summary is used only when its transcript prefix, instructions, worker, and policy
generation still match. It expires after two minutes; cancellation or a new
prompt invalidates it. Otherwise core compaction handles the transcript. This
process preserves the native SDK conversation and never rewinds it.

## Limits

The SDK's native Auto fallback is accepted when its classifier is unavailable;
completion does not prove that review occurred. Cursor-native child spawning is
disabled. The SDK exposes no public force-compaction or threshold control, manual
approval transport, arbitrary Claude-native tool cards, strict forced tool choice,
stop strings, PDF attachments, or per-response generation caps. Cursor turn
usage is reported when the SDK provides it; otherwise the Messages response
marks its local token estimate explicitly. Billed usage is queried separately,
on demand, and may lag while Cursor settles billing.

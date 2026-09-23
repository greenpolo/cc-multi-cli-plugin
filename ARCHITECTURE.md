# Architecture

See [AGENTS.md](AGENTS.md) for contributor rules and [README.md](README.md) for
usage. Provider setup and limits are documented in [docs/installation.md](docs/installation.md),
[docs/openai.md](docs/openai.md), [docs/cursor.md](docs/cursor.md),
[docs/zen.md](docs/zen.md), [docs/antigravity.md](docs/antigravity.md), [docs/grok.md](docs/grok.md),
[docs/permissions.md](docs/permissions.md), and [docs/platform-support.md](docs/platform-support.md).

## Overview

The plugin puts external models and coding harnesses inside one Claude Code
session. The launcher registers provider models and one Agent-tool worker type
per provider. The Node gateway routes requests, preserves Claude passthrough,
and coordinates sessions.
Claude Mods provide the in-engine control plane for model rows, worker rows,
permission state, progress, and compaction. [The local Mods reference](docs/claude-mods.md)
is required reading for changes to Claude Code UI or extensibility. Provider adapters own their model
catalogs, authentication, execution, and review boundaries.

```text
Claude Code session (/model, workers, prompts)
                  |
        Claude Mods control plane
                  |
             Node gateway
        /          |           \
   OpenAI       Zen       Cursor / Antigravity / Grok
 direct API   direct API   SDK or real CLI
 Claude loop  Claude loop  provider loop
```

## Request flow

Claude Code sends Anthropic Messages traffic and provider requests to the gateway.
The gateway passes Anthropic traffic through and translates direct-provider
requests. `/model` exposes provider model and effort rows. Each connected
provider's Agent-tool worker type runs that provider's picker rows; the Agent
tool's `model` parameter picks which. Each run reports a visible lifecycle: row,
elapsed time, streamed progress, completion, failure, and cancellation.

## Worker types

The Agent tool offers exactly one type per signed-in or enabled provider:
`multi-openai`, `multi-zen`, `multi-cursor`, `multi-antigravity`, and
`multi-grok`. A type's models are exactly that provider's rows in the session's
`/model` picker, so `--models`, `MULTI_MODELS`, and the provider-specific
`_EXTRA_MODELS`/`_MODELS` environment variables bound them. The Agent tool's
`model` parameter names a model as a short id (`composer-2.5`, `gpt-6-luna`) or
the full `multi/<provider>/<id>`; a Multi mod hook takes it out before Claude's
Agent schema check and resolves it against the catalog at spawn, rewriting the
spawn to the full id. An unknown id, another provider's model, a Claude alias,
or an effort-suffixed name (`gpt-6-luna-high`) refuses the spawn, naming the
provider's available models. Omitting `model` runs the provider default.
Effort is never part of a type or model name: OpenAI and Zen workers carry one
provider-wide default effort, while Cursor, Antigravity, and Grok workers apply
the session's `/effort`, validated by the provider.

## Execution contracts per provider

| Provider | Tool execution | Review | State ownership | Authentication |
| --- | --- | --- | --- | --- |
| OpenAI | Claude Code tools and loop | OpenAI account reviewer | Gateway and provider reasoning state | Codex login |
| Zen | Claude Code tools and loop | Claude-backed review where available | Gateway and Zen reasoning/cache state | Zen API key |
| Cursor | Cursor SDK loop | Cursor native review | Cursor SDK, scoped by run | Cursor SDK login |
| Antigravity | `agy` CLI loop | No reviewer | Antigravity native history and cache | `agy` login |
| Grok | `grok` CLI loop | No reviewer | Grok native sessions on disk | Grok Build account login |

OpenAI and Zen are direct model integrations. Their worker hooks record prompt
identity and let Claude Code run the tool loop. Full settings translation runs
at Cursor, Antigravity, and Grok prompts, or when a direct-model conversation requests
a harness worker. OpenAI
review stays with the originating OpenAI account. Zen never borrows Codex
review. Missing GPT review fails explicitly.

Cursor, Antigravity and Grok are harness integrations. Their SDK or CLI executes
tools, keeps native state, and applies provider authentication. Each finished native
action becomes a display row in the harness's own reply: a tool_use block named after
the native tool (`mcp__multi-core__run_command`) with the native parameters and a
gateway-issued token, answered by the Multi mod with the native output, so the row
sits in the transcript of the `/model` session or worker that ran it. Display tools
are never model tools: the gateway strips them from every provider's tools and
history, the mod defers them and refuses any call without an issued token, and the
gateway answers the engine's follow-up request with the reply's remaining text
without a native run. Nothing is replayed or re-executed. Cursor supports Auto, Plan, and Bypass. Antigravity uses its native CLI
with Claude policy enforcement at the prompt boundary. Grok carries the same
policy in its own run arguments, and each announced toolset is checked against
it because an unknown removal is accepted and ignored by that CLI.

All three harnesses share their session store, in-flight exchange registry,
response builder, durable completion, notices, and the transcript action summary from
`plugins/multi-core/src/gateway/harness-*.ts`. Grok and Antigravity additionally
share native process execution, text prompt preparation, and the native action
tracker (Cursor uses it too) that turns native actions into display rows; Cursor retains its
SDK and image-aware prompt format. Each provider still owns
its own event grammar, CLI argument construction, usage accounting, and (for
Cursor) SDK agent lifecycle. The shared layer owns turn leases, lock lifetime,
archival before subsequent dispatch, and durable completion before terminal
events. Identical in-flight requests observe the existing exchange. A different
request for the same busy identity is refused with a deterministic 400, rather
than queued against a native conversation that has moved on.

## Permissions

Claude's permission mode controls each provider at prompt boundaries through the
UserPromptSubmit and SubagentStart hooks. The gateway intersects worker rules,
provider capabilities, project settings, and platform policy. Unsupported modes,
unknown workers, untranslatable policies, and unavailable required reviewers fail
explicitly. Plan denies shell and edit capabilities. Bypass disables Cursor native
Auto review while retaining explicit restrictions. See [docs/permissions.md](docs/permissions.md).

Native harness actions do not enter Claude's PreToolUse or PermissionRequest
admission path. Their worker admission loads the selected settings and managed
policy sources. Provider SDK/CLI events supply progress and action observations
for display through Claude Mods; Claude's classic tool hooks do not observe each
native action. Antigravity native
children and MCP stay denied. Grok denies native subagents and MCP execution by
rule, and its announced toolset is verified because that CLI accepts an unknown
removal silently; its MCP tools stay visible to the model and are documented as
such. Explicit native workspace selection is required.

Claude's launcher enables on-demand tool discovery for the local gateway. Direct
provider adapters omit deferred tool schemas until Claude discovers or uses
them; tool references and loaded declarations survive later turns and provider
switches.

## Isolation

Every run isolates Claude session, worker, provider, and workspace identity.
Provider credentials and review contexts remain separate. Claude subscription
passthrough remains available; the plugin has no Claude token pool. External
operations retain external permissions. Each harness's `HarnessSessionStore`
keys its on-disk record on the provider-supplied identity, so session,
worker, provider, and workspace isolation holds at the shared-module layer as
well as in each provider's own state.

## State

`state-lock.ts` serializes native state with a portable marker-file lock that survives crashes. Durable
run IDs support terminal-result recovery. A recoverable run resumes its native
record; an uncertain run does not rerun actions blindly. Claude, OpenAI, and Zen
conversations use Claude Code's compaction without Multi's harness checks;
Cursor, Antigravity and Grok compaction remains provider-owned and policy-bound. Follow-ups forward the
newest turn after the last assistant response. If outer history no longer contains
the saved response, the harness emits a notice and continues on its native record;
it does not require a matching prompt hash or unique response anchor. Native state
is never rewound. Compaction summarizes authenticated context while preserving the
native record. Cache reuse and usage accounting remain provider-owned.
The shared response builder reports a harness turn's last model call, its live
context, in the standard usage fields and the turn's consumption in `multi_usage`
([docs/claude-mods.md](docs/claude-mods.md)); each adapter supplies both.

`HarnessSessionStore` (`gateway/harness-session.ts`) owns the loading gate,
record validation, and lock lifetime. Persisted `saved` fields are separate from
live `runtime` attachments; SDK handles cannot enter a saved record accidentally.
`acquireLease` holds the identity through replay, recovery, and dispatch. Releasing
the lease ends the turn; shutdown releases idle records and leaves busy locks
owned until their leases finish. `loadOnly` uses the same loading gate and rejects
busy records. Every harness maps `HarnessBusyError` to a deterministic 400.

`ExchangeRegistry` (`gateway/harness-exchange.ts`) lets identical requests observe
one native run before a second lease is attempted. Its typed metadata remains
provider-owned. `harness-completion.ts` archives a previous reply before the next
native dispatch can replace it, then commits the new response and replay events
in one atomic session write before emitting terminal events. Provider usage and
native recovery decisions stay in the adapters.

Cursor upgrades preserve v2 native agents and pending run IDs. The store holds
both the old filename's lock and the current v3 filename's lock while migrating
and using a record. Existing v3 state takes precedence when both records identify
the same agent; conflicting native identities fail explicitly. The original v2
file is preserved. Cursor's 32-agent budget counts attached SDK handles and
in-flight attachment reservations, not disk-only replay records. Eviction closes
an idle SDK handle while retaining its native identity for later resume.
Handles with an in-flight billed usage query are not evicted. A detached SDK
record's `running` status is not a live ownership claim: the existing interrupted
continuation notice remains the fallback when no terminal result can be recovered.

Replay validation is provider-parameterized: new replies from every harness are
text-only, and Cursor still accepts the display-only `tool_use` blocks that the
retired pseudo-MCP rows wrote into records before 0.2.2, so those records replay. `gateway/conversation.ts` normalizes Messages content
and media for Cursor and OpenAI without coupling Cursor to OpenAI request
construction; provider-specific reasoning decoding stays with OpenAI.

## Platform layer

The process tree tracks and cancels child processes. Executable resolution selects
platform-appropriate commands. Managed-policy sources are admitted per platform.
Atomic writes protect settings and state. Install shims bootstrap the real Claude
executable and preserve its arguments. Grok and Antigravity spawn their native
CLI through the shared `runNativeCli` process runner
(`gateway/harness-process.ts`), which owns the spawn/kill/timeout cascade,
stdout/stderr capture, and cancellation plumbing; each provider still supplies
its own argument construction, event grammar, and environment allowlist.
Linux, WSL, macOS, and Windows support is
described in [docs/platform-support.md](docs/platform-support.md).

## Current design contracts

These summarize the current architecture, not permanent restrictions on future
features requested by the maintainer.

- Keep authentication, model catalogs, review, and native state with each provider.
- Keep shared Claude protocol types and cross-provider helpers in `gateway/`.
- Never replay observed external tool events as Claude tool calls.
- Apply Claude permission mode and explicit capability restrictions at prompt boundaries.
- Propagate cancellation and expose progress, completion, and failure.
- Fail on ambiguous ownership, unsupported policy, unknown workers, or missing review.
- Never borrow another provider's reviewer or infer billing from a model name.
- Never rewind native state or repeat uncertain actions.
- Isolate every session, worker, provider, workspace, and credential context.

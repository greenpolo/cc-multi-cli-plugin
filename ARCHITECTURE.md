# Architecture

See [AGENTS.md](AGENTS.md) for contributor rules and [README.md](README.md) for
usage. Provider setup and limits are documented in [docs/installation.md](docs/installation.md),
[docs/openai.md](docs/openai.md), [docs/cursor.md](docs/cursor.md),
[docs/zen.md](docs/zen.md), [docs/antigravity.md](docs/antigravity.md), [docs/grok.md](docs/grok.md),
[docs/permissions.md](docs/permissions.md), and [docs/platform-support.md](docs/platform-support.md).

## Overview

The plugin puts external models and coding harnesses inside one Claude Code
session. The launcher registers provider models and named workers. The Node
gateway routes requests, preserves Claude passthrough, and coordinates sessions.
Claude Mods provide the in-engine control plane for model rows, worker rows,
permission state, progress, and compaction. Provider adapters own their model
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
requests. `/model` exposes provider model and effort rows. Named workers expose
explicit provider choices. Each run reports a visible lifecycle: row, elapsed
time, streamed progress, completion, failure, and cancellation.

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
at Cursor and Antigravity prompts, or when a direct-model conversation requests
a harness worker. OpenAI
review stays with the originating OpenAI account. Zen never borrows Codex
review. Missing GPT review fails explicitly.

Cursor, Antigravity and Grok are harness integrations. Their SDK or CLI executes
tools, keeps native state, and applies provider authentication. Claude displays external
actions and progress; it never replays those actions as executable Claude tool
calls. Cursor supports Auto, Plan, and Bypass. Antigravity uses its native CLI
with Claude policy enforcement at the prompt boundary. Grok carries the same
policy in its own run arguments, and each announced toolset is checked against
it because an unknown removal is accepted and ignored by that CLI.

All three harnesses share their session store, in-flight exchange registry,
response builder, notice text, native process runner, and prompt preparation
from `plugins/multi-core/src/gateway/harness-*.ts`. Each provider still owns
its own event grammar, CLI argument construction, usage accounting, and (for
Cursor) SDK agent lifecycle; the shared modules hold only plumbing that was
identical across providers. A prompt sent for an identity with a run already
in flight is refused with a deterministic 400 on every harness, never queued
or retried against a native conversation that has moved on.

## Permissions

Claude's permission mode controls each provider at prompt boundaries through the
UserPromptSubmit and SubagentStart hooks. The gateway intersects worker rules,
provider capabilities, project settings, and platform policy. Unsupported modes,
unknown workers, untranslatable policies, and unavailable required reviewers fail
explicitly. Plan denies shell and edit capabilities. Bypass disables Cursor native
Auto review while retaining explicit restrictions. See [docs/permissions.md](docs/permissions.md).

Native harness actions do not enter Claude's PreToolUse or PermissionRequest
admission path. Their worker admission loads the selected settings and managed
policy sources, while those hooks observe native activity. Antigravity native
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
newest turn after the last assistant response. Outer history changes continue
only with a matching prompt hash or unique saved-response anchor. Native state is
never rewound. Compaction summarizes authenticated context while preserving the
native record. Cache reuse and usage accounting remain provider-owned.

Cursor, Antigravity, and Grok persist and load native session records through
the shared `HarnessSessionStore` (`gateway/harness-session.ts`), which owns
the busy/loading gate, the atomic-write lock, and record validation; a
provider supplies only its own field extensions and a default record. An
in-flight native turn is tracked by the shared `ExchangeRegistry`
(`gateway/harness-exchange.ts`), which lets a second identical request join
the running turn or replay a settled one instead of starting a second paid
turn. `HarnessSessionStore.acquire` and `.loadOnly` are the only way to reach
a session record, and both throw `HarnessBusyError` for a busy identity
instead of queuing: every harness reports this as a 400, so a prompt sent
while a run is in flight is refused rather than retried against native state
that has since moved on.

Reading a record takes its lock. Cursor's replay path goes through `loadOnly`
like every other path, so even a turn answered entirely from disk holds the
record's lock file until the harness closes; the record it caches is the same
object the turn would later mutate, so an unlocked shortcut would reintroduce
the recovery race the lock exists to prevent. Cursor's interrupted-state
recovery holds the turn with `acquire` for its whole duration, because it both
awaits the native run and rewrites the record: a second request that slipped in
between would dispatch a run whose `pendingRun` the finishing recovery then
cleared. Cursor's agent budget counts records that actually hold a native SDK
agent, so a cached record that never created one evicts nothing. Replay
validation is provider-parameterized: Cursor's replies may carry the
display-only `tool_use` blocks a Claude Mods row produces, while Grok and
Antigravity stay text-only.

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

## Design rules

- Keep authentication, model catalogs, review, and native state with each provider.
- Keep shared Claude protocol types and cross-provider helpers in `gateway/`.
- Never replay observed external tool events as Claude tool calls.
- Apply Claude permission mode and explicit capability restrictions at prompt boundaries.
- Propagate cancellation and expose progress, completion, and failure.
- Fail on ambiguous ownership, unsupported policy, unknown workers, or missing review.
- Never borrow another provider's reviewer or infer billing from a model name.
- Never rewind native state or repeat uncertain actions.
- Isolate every session, worker, provider, workspace, and credential context.

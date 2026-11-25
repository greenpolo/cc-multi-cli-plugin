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
permission state, progress, and compaction. The hooks (`plugins/multi-core/hooks/`)
reach the gateway through one client (`hooks/gateway.ts`) and keep state in
`$.state` so it survives a hot reload. The gateway mints a per-session mod key
(`mod-keys.ts`) on the mod's first request and, once the mod echoes it, refuses
`/multi/mod/*` requests carrying only the environment token, so a shell command
cannot loosen a session's permissions. Session state is dropped on `session.end`,
not when a client detaches. [The local Mods reference](docs/claude-mods.md)
is required reading for changes to Claude Code UI or extensibility. Provider adapters own their model
catalogs, authentication, execution, and review boundaries.

Each provider is one folder, `plugins/multi-<name>/`. Its `provider.json` manifest
states its name, label, kind (`direct`: Claude Code runs the tools; `harness`: the
provider's SDK or CLI does), display order, and review and usage text. Its
`src/adapter.ts` default-exports the adapter core loads: sign-in and model discovery
for a launch, the harness or request builder that runs it, its launcher flags, and its
account verb. Core reads the manifests (`gateway/provider.ts`), loads the adapters
(`gateway/provider-adapter.ts`), and imports no provider code. The hooks run inside
Claude Code and cannot read those files, so they keep one small table
(`hooks/provider.ts`) that `npm run check:providers` compares with the manifests.

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

## Desktop sessions

The Claude desktop app starts Claude Code itself (with `CLAUDE_CODE_ENTRYPOINT`
`claude-desktop` and Anthropic's own `ANTHROPIC_BASE_URL`), so no launcher sets the
session up. The mod does it instead (`hooks/register.ts`, `hooks/desktop.ts`): at
`session.start` in such a session, unless a launcher's gateway is already set, it starts
`src/serve.ts` with `$.process.spawn` in the session's folder, waits on `$.clock` (8 s)
for its one-line handshake (`launch/desktop.ts`: the variables to set, the worker types,
whether the front door is in use, and a notice), sets each variable with `$.env.set`, and
registers each worker with `$.agent.register`, which Claude Code names
`multi-core:<label>` (`workerTypeName` in `gateway/provider.ts` reads it back). `serve.ts`
and the launcher start the gateway through one function (`launch/gateway.ts`). The
gateway ends on `/multi/mod/stop`, which the mod sends at a `session.end` that is not a
`/clear` or a resume, when the Claude Code that started it is gone, or when the module
unloads; a hot reload starts a new one. Any failure leaves plain Claude with a one-line
notice.

Claude Code reads `NODE_EXTRA_CA_CERTS` once, at its start, before any mod runs, and
`$.env.set` of it changes nothing for Claude Code's own connections. So the front door in
a desktop session uses the certificate setup installs (`launch/certificate.ts`, P-256,
397 days, renewed by setup in its last 30, key 0600 under Multi's data directory), which
Claude trusts because setup names its trust file (the user's own extra certificates plus
this one) in `env.NODE_EXTRA_CA_CERTS` of Claude's user settings. `serve.ts` uses the
front door only when the session's `NODE_EXTRA_CA_CERTS` file holds that certificate and it
has a day left; otherwise it uses `ANTHROPIC_BASE_URL`. Desktop sessions take no launcher
settings either, so `/model` rows come from `modelPicker` in Claude's user settings:
setup writes the connected providers' rows, and `serve.ts` refreshes them when they
change. A settings hook (`settings.read`) cannot carry them: its answer reached neither
the model list nor the environment on Claude Code 2.1.330. Uninstall restores both
settings.

## Request flow

Claude Code sends Anthropic Messages traffic and provider requests to the gateway.

How Claude Code reaches the gateway depends on its login. Signed in to claude.ai, with
no API key and no provider or base URL of the user's own, the gateway is Claude Code's
HTTPS proxy (the front door, `gateway/front-door.ts`) and `ANTHROPIC_BASE_URL` is left
alone, so Claude Code stays first-party and keeps Remote Control. The front door ends
the TLS connection to `api.anthropic.com` with a certificate made for the session
(`gateway/self-signed.ts`) that only the launched Claude Code trusts, through
`NODE_EXTRA_CA_CERTS`, and hands the requests to the ordinary handler; a decrypted
request without the session token goes to Anthropic untouched. Every other host is a
byte tunnel, through the user's own proxy when one applies. Commands Claude runs get the
user's own proxy settings back from a `CLAUDE_ENV_FILE` script (`launch/front-door.ts`).
A first-party Claude Code may send a turn as part of a message thread kept on Anthropic's
servers (a `thread` field; a continue carries only the new messages and no tools). Claude
models keep that; for an external model the gateway answers Anthropic's
`thread_unsupported_request` error, and Claude Code resends the turn in full and keeps that
model stateless for the session (`gateway/request.ts`). Any other session, or `MULTI_GATEWAY_TRANSPORT=base-url`, uses `ANTHROPIC_BASE_URL`.
The gateway passes Anthropic traffic through untouched except for a successful
`/v1/messages` reply's Agent calls naming a Multi provider worker and a string
`model`: it removes `input.model` before Claude Code sees the call, preserving
Anthropic's verdicts. In SSE only that Agent block's JSON deltas wait until its
stop frame; other frames retain their bytes. JSON replies update content-length.
Every path other than Messages and `/multi/*` is forwarded as raw bytes, and a
failed upstream connection is dropped so Claude Code's own retry runs. The gateway
also translates direct-provider requests. It honors `HTTPS_PROXY` and forwards to
a caller-set
`ANTHROPIC_BASE_URL`. A `claude` started by a command inside the session gets
the session-start environment back (`nested-env.ts`, a PATH shim and the
bootstrap), so it never routes through the session gateway. Hosted-API
providers build their own requests: `gateway/provider-request.ts` defines the
contract, each direct provider's `gateway-request.ts` implements it, and the gateway
owns keepalive, events, and failure mapping. `gateway/provider.ts` is the one reader
of a model ID's provider prefix. The Responses translation and SSE reader live in
`gateway/responses.ts`. `/model` exposes provider model and effort rows. Each connected
provider's Agent-tool worker type runs that provider's picker rows; the Agent
tool's `model` parameter picks which. Each run reports a visible lifecycle: row,
elapsed time, streamed progress, completion, failure, and cancellation.

## Worker types

The Agent tool offers exactly one type per signed-in or enabled provider:
`OpenAI`, `Zen`, `Cursor`, `Antigravity`, and
`Grok`. A type's models are exactly that provider's rows in the session's
`/model` picker, so `--models`, `MULTI_MODELS`, and the provider-specific
`_EXTRA_MODELS`/`_MODELS` environment variables bound them. The Agent tool's
`model` parameter names a model as a short id (`composer-2.5`, `gpt-6-luna`) or
the full `multi/<provider>/<id>`; the gateway removes it before Claude's Agent
schema check, and a Multi mod hook resolves the recorded selection against the
catalog at spawn, setting the spawn to the full id. The gateway keeps up to 2,048 selections, keyed by session
and tool_use id, and retains them through denied or retried spawns. Only replies
without session identity use globally unique tool_use ids as a lookup fallback.
Session end clears identified records. Built replies normalize before emitting
or saving content, so streams and saved replies agree. An unknown id, another
provider's model, a Claude alias, or an effort-suffixed name (`gpt-6-luna-high`) refuses the spawn, naming the
provider's available models. Omitting `model` runs the provider default.
Effort is never part of a type or model name: OpenAI and Zen workers carry one
provider-wide default effort, while Cursor, Antigravity, and Grok workers apply
the session's `/effort`, validated by the provider.

## Execution contracts per provider

| Provider | Tool execution | Review | State ownership | Authentication |
| --- | --- | --- | --- | --- |
| OpenAI | Claude Code tools and loop | OpenAI account reviewer | Gateway and provider reasoning state | Codex login |
| Zen | Claude Code tools and loop | No reviewer; Auto runs unreviewed | Gateway and Zen reasoning/cache state | Zen API key |
| Cursor | Cursor SDK loop | Cursor native review | Cursor SDK, scoped by run | Cursor SDK login |
| Antigravity | `agy` CLI loop | No reviewer | Antigravity native history and cache | `agy` login |
| Grok | `grok` CLI loop | No reviewer | Grok native sessions on disk | Grok Build account login |

OpenAI and Zen are direct model integrations. Their worker hooks record prompt
identity and let Claude Code run the tool loop. Full settings translation runs
at Cursor, Antigravity, and Grok prompts, or when a direct-model conversation requests
a harness worker. OpenAI
review stays with the originating OpenAI account. Zen never borrows Codex
review. If discovery cannot find the OpenAI reviewer at launch, Auto runs OpenAI
unreviewed and the status line says so. A discovered reviewer failing on a call
refuses that action with an evaluated verdict.

Cursor, Antigravity and Grok are harness integrations. Their SDK or CLI executes
tools, keeps native state, and applies provider authentication. Each finished native
action becomes a display row in the harness's own reply: a tool_use block named after
the native tool (`mcp__multi-core__run_command`) with the native parameters and a
gateway-issued token, answered by the Multi mod with the native output, so the row
sits in the transcript of the `/model` session or worker that ran it. Display tools
are never model tools: they register in the engine lazily, only when a harness
prompt, worker, or step needs them, and the gateway strips them (and their
`tool_reference` blocks) from every provider's tools and history. The mod defers
them and refuses any call without an issued token, and the
gateway answers the engine's follow-up request with the reply's remaining text
without a native run. Nothing is replayed or re-executed. Cursor supports Auto, Plan, and Bypass. Antigravity uses its native CLI
with Claude policy enforcement at the prompt boundary. Grok carries the same
policy in its own run arguments, and each announced toolset is checked against
it because an unknown removal is accepted and ignored by that CLI. Antigravity
runs an allowlist built from the Claude grant: unmapped tools are denied in
every mode, scheduling, messaging, task, and knowledge-deletion tools are always
denied, and write tools cannot touch agy's own hook or config files.

All three harnesses share their session store, in-flight exchange registry,
response builder, durable completion, notices, failure classifier, and the
transcript action summary from `plugins/multi-core/src/gateway/harness-*.ts`.
Grok and Antigravity additionally share a CLI harness base (`harness-cli.ts`:
the request flow around one native run), native process execution, text prompt
preparation, and the native action tracker (Cursor uses it too) that turns
native actions into display rows; Cursor retains its
SDK and image-aware prompt format. Each provider still owns
its own event grammar, CLI argument construction, usage accounting, and (for
Cursor) SDK agent lifecycle. The shared layer owns turn leases, lock lifetime,
archival before subsequent dispatch, and durable completion before terminal
events. Identical in-flight requests observe the existing exchange. A different
request for the same busy identity is refused with a deterministic 400, rather
than queued against a native conversation that has moved on.

## Permissions

Claude's permission mode controls each provider at prompt boundaries through the
UserPromptSubmit and SubagentStart hooks. Direct-model review uses the mode in
the request's `classifier_context.permission_mode`. The gateway keeps one record per
session (`gateway/mode-hook.ts`): the mode, workspace and model of the latest prompt.
A worker adds its agent type's own tool rules and inherits the rest; a worker the
hooks did not announce inherits the session's record.

No native run is refused over its mode or over a setting its harness cannot enforce.
Plan stays read-only and Bypass stays unreviewed; every other mode runs as Auto.
`gateway/harness-settings.ts` reads what carries over from Claude's settings: bare
tool denials and tool lists. Ask rules, sandbox settings and argument-specific deny
rules have no native form, so they are skipped and named in a one-line notice at the
start of the run. A provider without a reviewer runs Auto unreviewed and says so;
Plan refuses its actions. See [docs/permissions.md](docs/permissions.md).

Native harness actions do not enter Claude's PreToolUse or PermissionRequest
admission path. Their worker admission loads the selected settings and managed
policy sources. Provider SDK/CLI events supply progress and action observations
for display through Claude Mods; Claude's classic tool hooks do not observe each
native action. Antigravity native
children and MCP stay denied. Grok denies native subagents and MCP execution by
rule, and its announced toolset is verified because that CLI accepts an unknown
removal silently; its MCP tools stay visible to the model and are documented as
such. Explicit native workspace selection is required.

The gateway is the verdict arbiter for every reply it serves. `provider.ts` holds
one policy table: OpenAI uses its injected account reviewer, Cursor reviews native
actions and fails open, and Zen, Antigravity and Grok run Auto unreviewed. The
status line displays that table's statement. `verdicts.ts` owns the `Reviewer`
interface, read-only skip list, Plan checks and failure-to-flagged rule.
`server.ts` alone finalises a `ServedReply` and emits `message_delta` and
`message_stop`. Whenever a request carries `safeguards`, its completed reply has
an available result map covering every tool id, even on empty and keepalive
failure replies. Builders cannot set results or emit terminal events. A broken
stream ends with an error without claiming completion. Failure text is filtered
so it cannot disable server verdicts in Claude Code.

OpenAI reviews independent tools with at most four concurrent investigations per
reply and four across the process, each bounded at 60 seconds including queue
time. Read, Glob, Grep and coordination/UI tools pass before mode checks without
reviewer calls. Completed harness rows and handbacks pass even when the request
omits the mode: native admission already applied it. The provider owns its guardian policy and
read-only filesystem investigation. The core retains a bounded map of the latest
tool-bearing main requests for worker authorization (sent only with worker
reviews), and resolves cwd from the
prompt snapshot with launcher cwd as fallback. OpenAI omits tool schemas and
bounds review evidence below 1 MiB, retaining the system head and recent messages
with explicit omission markers. Claude's private classifier
prompts are never parsed or intercepted: Anthropic responses pass through byte
for byte. Every harness's `SubagentHandback` receives `not_flagged`: reports,
including any embedded instructions, reach the parent without another review.

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
native dispatch can replace it, then commits the new response and content-only replay events
in one atomic session write before returning to the gateway finaliser. Each serve
computes verdicts from its current request; native records carry no verdicts or
terminal events. On load the store strips old verdicts and terminal events and
saves the migrated record under its existing locks. Archives are migrated before
replay too; native IDs, pending runs and content are preserved. Provider usage and
native recovery decisions stay in the adapters.

Cursor migrates v2 records under both filenames' locks and refuses when v2 and v3
name different agents. Its 32-agent budget counts attached SDK handles; eviction
closes an idle handle and keeps its native identity for a later resume.

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
- Fail on ambiguous ownership or unknown models; never refuse a native run over its permission mode or an unenforceable Claude setting.
- A provider without a reviewer runs Auto unreviewed and says so; Plan refuses actions.
- Never borrow another provider's reviewer or infer billing from a model name.
- Never rewind native state or repeat uncertain actions.
- Isolate every session, worker, provider, workspace, and credential context.

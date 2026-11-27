# OpenAI

OpenAI models provide direct Responses requests while Claude Code runs the tool loop.

## Setup

1. Install the core and OpenAI plugins. See [docs/installation.md](installation.md).
2. Run `/multi-openai:login`.
3. Complete the official Codex ChatGPT login in your browser.
4. Relaunch the session so the model picker and workers load.

Codex stores the ChatGPT login in its `auth.json`. Credential renewal is CLI-owned. The gateway asks Codex to renew an expiring login and retries one HTTP authentication rejection. Run `codex login` when renewal fails.

## Models and effort

Use `/model multi/openai/<model-id>` or choose a row in `/model`. Use `/effort <value>` for the main session.

Models: `gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra`,
`gpt-6-luna`.

## Workers

The Agent tool's `OpenAI` type runs any of these: pass `model: <id>`
(for example `model: gpt-6-luna`) to pick one, or omit `model` to run the
default, `gpt-6.2-sol`. An unknown id, another provider's model, or an
effort-suffixed name such as `gpt-6-luna-high` refuses the spawn, naming the
available OpenAI models. `OpenAI` runs one provider-wide medium effort;
effort is never part of the model name, and the session's `/effort` does not
change it. Workers appear as native subagent entries with model activity,
elapsed time, progress, and completion status. Cancelling the Claude request
aborts the OpenAI request and worker activity.

## Instruction profile

OpenAI requests append a short Claude Code compatibility note from
`plugins/multi-openai/src/instructions.md`. It identifies the host's tools,
permission and compaction boundaries without adding personal preferences or
planning, delegation, or writing-style defaults. Claude's existing instructions
stay intact. The note applies to OpenAI inference and token counting, not other
providers or the independent reviewer.

`npm run test:live:openai-instructions` checks it with at most three paid requests.

## Prompt caching and continuation

The gateway sends an opaque cache key scoped by Claude session, worker, and model. A recognized session keeps the key stable across gateway restarts; an unrecognized session gets gateway-local affinity. This is a routing hint and does not guarantee cache hits.

On continuation, visible conversation context is forwarded to OpenAI. Provider-owned reasoning state stays with OpenAI and is excluded when switching providers. OpenAI requests use Claude Code's tool loop, so Claude tool history remains part of the request context.

## Limits

The gateway rejects unsupported content, media, schemas, tool choices, provider-hosted tools, and arbitrary model or effort IDs. OpenAI document input supports base64 PDFs and plain text; URL documents and provider file IDs fail. Token counts are local estimates. OpenAI requests have no implicit gateway deadline, while client cancellation and explicit time limits apply.

OpenAI tool uses are reviewed inline by the originating account's `codex-auto-review` reviewer on ChatGPT-plan quota. Read-only and coordination/UI tools on core's skip lists pass without a reviewer request. Each review has a 60-second budget including queue time, with at most four concurrent reviews per reply and across the process. Denial, malformed evidence, unavailable evidence, timeout or reviewer failure returns `flagged` with a plain explanation; Claude's local classifier is not used. If reviewer discovery fails at launch, OpenAI Auto runs unreviewed and says so in the status line; Plan refuses actions without a reviewer. Bypass mode sends no reviews. The reviewer uses its guardian policy and, as the Codex CLI does, one reviewer thread per session and worker: the first review sends a compact transcript (recent user and assistant text, tool calls and output, the opening task, and for a worker its parent's recent transcript), later reviews add only new entries so the thread is served from OpenAI's prompt cache, with bounded read-only workspace inspection. Omissions are marked. A spent Codex window is reported with OpenAI's own usage-limit message and reset time. See [docs/permissions.md](permissions.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).

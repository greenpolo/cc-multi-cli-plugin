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

| Picker row | Model | Named worker |
| --- | --- | --- |
| OpenAI · `gpt-6-astra` | `gpt-6-astra` | `openai-native` |
| OpenAI · `gpt-5.6-sol` | `gpt-5.6-sol` | `openai-sol` |
| OpenAI · `gpt-5.6-terra` | `gpt-5.6-terra` | `openai-terra` |
| OpenAI · `gpt-5.6-luna` | `gpt-5.6-luna` | `openai-luna` |

Each worker has `-low`, `-medium`, `-high`, `-xhigh`, and `-max` variants. An unsuffixed worker uses medium effort. For example, `openai-luna-high` sends `high` as OpenAI reasoning effort.

Picker rows include `behavesAs` metadata for Claude client compatibility. This metadata selects a Claude profile for picker behavior and does not change the `multi/openai/...` ID or claim provider equivalence.

## Workers

Ask Claude to use a named worker, such as `openai-luna-high`. Workers appear as native subagent entries with model activity, elapsed time, progress, and completion status. Cancelling the Claude request aborts the OpenAI request and worker activity.

## Instruction profile

OpenAI requests append a short Claude Code compatibility note from
`plugins/multi-openai/src/instructions.md`. It identifies the host's tools,
permission and compaction boundaries without adding personal preferences or
planning, delegation, or writing-style defaults. Claude's existing instructions
stay intact. The note applies to OpenAI inference and token counting, not other
providers or the independent reviewer.

## Prompt caching and continuation

The gateway sends an opaque cache key scoped by Claude session, worker, and model. A recognized session keeps the key stable across gateway restarts; an unrecognized session gets gateway-local affinity. This is a routing hint and does not guarantee cache hits.

On continuation, visible conversation context is forwarded to OpenAI. Provider-owned reasoning state stays with OpenAI and is excluded when switching providers. OpenAI requests use Claude Code's tool loop, so Claude tool history remains part of the request context.

## Limits

The gateway rejects unsupported content, media, schemas, tool choices, provider-hosted tools, and arbitrary model or effort IDs. OpenAI document input supports base64 PDFs and plain text; URL documents and provider file IDs fail. Token counts are local estimates. OpenAI requests have no implicit gateway deadline, while client cancellation and explicit time limits apply.

OpenAI actions require the originating OpenAI account's reviewer capability when automatic review is requested. Missing reviewer capability, ambiguous origin, malformed evidence, unsupported actions, and unavailable evidence fail explicitly. See [docs/permissions.md](permissions.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).

# AGENTS.md

Orientation for AI agents (Claude, Codex, Cursor) working in this repo. **Read this first.**

## What this is

`cc-multi-cli-plugin` is a Claude Code plugin that **offloads heavy coding work to external CLIs** — Codex, Cursor (headless `agent -p`), Antigravity, and OpenCode (headless `opencode run --format json`) — so the orchestrating Claude session spends as few tokens as possible. The plugin's entire value is *token reduction by delegation*. Keep that goal central to every change.

## The golden rule

Claude does as little thinking as possible; the external CLI does the work.

- The per-command subagents (`plugins/multi/agents/codex-*.md`) are **thin forwarders**: they build exactly one companion command, run it, and return stdout unchanged. They must not read files, reason about the task, or "help."
- Forwarder models are tuned by role. Forwarders that **frame/route** the prompt — `codex-execute`, `codex-rescue`, and the cursor/antigravity ones — run on **Sonnet**, because shaping the task well (model/effort choice, prompt framing) materially improves what the external CLI then produces (this mirrors the official `codex-plugin-cc` rescue subagent). Forwarders that do **no framing** and only bridge to the companion — `codex-review` — run on **Haiku**, the correct cheapest model for a pure forwarder. Keep them all thin either way: never add file reading or task reasoning.
- Do **not** spawn fleets of Claude subagents to do or validate work in this repo — that defeats the plugin's purpose. Validate with `npm test` (offline) or by delegating to a CLI.

## The request chain

```
/codex:<cmd>  →  multi:codex-<role> (forwarder, Haiku)  →  multi-cli-companion.mjs <subcommand> --cli <name>
              →  lib/adapters/<name>.mjs  →  (codex app-server broker | cursor headless `agent -p` | antigravity headless `agy -p` | opencode headless `opencode run --format json`)  →  external CLI
```

See `ARCHITECTURE.md` for the full picture and the job / state / broker model.

## Build & test

No dependencies; uses Node's built-in test runner (Node ≥ 20; repo runs on 25).

- `npm test` — fast, **offline** unit tests. Run this to self-verify any change. No CLI calls, no tokens.
- `npm run test:live` — end-to-end; **spawns real Codex** (costs tokens + time). Run only when touching the live path.

**Definition of done** for a change: `npm test` passes, no `DEP0190` warnings, and `CHANGELOG.md` updated for user-facing changes.

## Map

- `plugins/multi/` — the hub plugin: `agents/` (forwarders), `commands/` (slash cmds), `skills/` (forwarder contracts), `schemas/`, `prompts/`, `hooks/`.
- `plugins/multi/scripts/multi-cli-companion.mjs` — CLI entrypoint; dispatches subcommands (`task`, `review`, `adversarial-review`, `status`, `result`, `cancel`, `setup`).
- `plugins/multi/scripts/lib/adapters/` — one adapter per CLI. Interface in `CONTRACT.md`.
- `plugins/multi/scripts/lib/` — shared runtime: broker lifecycle, app-server, job control, render, git. The ACP client layer lives in `lib/acp/` (`client.mjs` = `runAcpTurn` on the official SDK, `resolve.mjs`, `diagnostics.mjs`); a legacy `lib/acp-client.mjs` predates it and is slated for deletion.
- `plugins/{codex,cursor,antigravity,opencode}/` — per-CLI command slices that forward into `multi`.
- `test/` — `unit/` (offline) + `fixtures/` (sandbox helper). `test:live` reuses `plugins/multi/scripts/test/`.

## Landmines

- **Broker lifecycle**: the Codex app-server broker is a detached per-cwd daemon, reused across tasks. The SessionEnd hook reaps the session's *primary*-cwd broker; brokers for any other cwd self-terminate after an idle window (`CODEX_COMPANION_BROKER_IDLE_MS`, default 600000 ms — see `app-server-broker.mjs` + `lib/broker-lifecycle.mjs` → `shouldIdleShutdown`). Set the env to `0` to disable idle shutdown.
- **State is per-cwd**: jobs and brokers key off the working directory; always pass `--cwd`. Parallel agents should use separate worktrees / cwds to stay isolated.
- **`spark`** (`gpt-5.3-codex-spark`) is rejected on ChatGPT-auth Codex accounts — expect a 400; not a bug.
- **Cursor uses headless `agent -p` by default** (ACP is opt-in via `MULTI_TRANSPORT_CURSOR=acp`): on headless the prompt is delivered on stdin (newline-safe), models pass through as flat `--model` names (default `auto`), roles map to flags (`delegate`→agent+`--force --trust`, `research`/`explore`→`--mode ask --force`), and cancel is the generic process-tree kill. `--until-done` loops `--resume` turns. **Cursor's shell is slow/unreliable on Windows** (host-PATH/WSL, open upstream), so `/cursor:delegate` defers build/test verification to the caller (Claude) — file writes and web/codebase reads are unaffected.
- **OpenCode uses headless `opencode run --format json` by default** (ACP is opt-in via `MULTI_TRANSPORT_OPENCODE=acp`): on headless the prompt is on stdin, NDJSON event stream on stdout. Read-only roles (`research`, `explore`) are enforced via injected oc-* primary agents with write/edit/bash denied (no `--read-only` flag). Write roles use `--dangerously-skip-permissions`. `--until-done` is supported; `--effort` is not. Default model: `opencode/claude-opus-4-8` (Zen). **Token-offload caveat:** `anthropic/*` models = zero offload (same Claude bill). Use `opencode/*`, `openai/*`, `google/*`, etc. for real offload. Set `OPENCODE_CLI_DEFAULT_MODEL` or `OPENCODE_CLI_PATH` for overrides.
- **ACP transport** (`lib/acp/client.mjs`, official `@agentclientprotocol/sdk`): Cursor + OpenCode have dual-transport adapters selecting ACP vs headless per turn from `MULTI_TRANSPORT_<CLI>`. ACP gives in-protocol model select (`set_config_option` vs the live options list), read-only via `set_mode`/deny-env, and `session/cancel` (OpenCode mislabels cancel as `end_turn`, so the client treats cancel-requested+ended as cancelled). Inactivity watchdog covers the handshake; `MULTI_ACP_INACTIVITY_MS`/`MULTI_ACP_OVERALL_MS` tune it. Codex (ASP) and Antigravity (`agy`) have no ACP path.
- **Forwarders only have `Bash`** (review additionally `git`) — by design. Don't add tools.

## Conventions

- Keep files small and single-purpose. Smaller files = parallel agents don't collide. Splitting the two monoliths — `multi-cli-companion.mjs`, `lib/adapters/codex.mjs` — is ongoing; the pure option normalizers were extracted to `lib/task-options.mjs` as the first step. Continue by pulling out one cohesive, independently-testable unit at a time and verifying with `npm test`.
- Add or extend a unit test with every behavior change. Pin contracts in tests, not in a smart model's head — this is what lets the thin forwarders (all `model: sonnet`) and offloaded CLIs stay correct.
- AI-authored research/plans stay local: put scratch in `.agent/` (gitignored). `*_RESEARCH.md` and `/docs/superpowers/` are already gitignored.

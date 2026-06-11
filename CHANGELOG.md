# Changelog

## Unreleased

### Fixed

- **ACP cancel dispatch now reports `transport: "process-tree"` when there is no in-flight ACP turn in the calling process** (the cross-process cancel case — the mechanism that actually does the work is the companion's process-tree kill; the ACP child sits inside the worker's tree). Previously it reported `"acp"` while doing nothing in-process, which was dishonest and also made the suite sensitive to ambient `MULTI_TRANSPORT_*` env (3 pre-existing headless cancel tests failed when the dogfood flags were set session-wide). `transport: "acp"` is now reported only when a live in-flight handle was actually cancelled in-protocol. Suite verified green both with and without the ambient flags.

## 0.1.2 — 2026-06-11

### Added

- **ACP transport layer (slice 1): a shared, SDK-backed turn runner for the Cursor + OpenCode ACP path.** New `plugins/multi/scripts/lib/acp/client.mjs` exports `runAcpTurn(spec)`, a policy layer over the official `@agentclientprotocol/sdk` `ClientSideConnection`: it spawns one ACP child per turn, runs initialize → newSession → (optional set_mode / set_config_option model) → prompt, accumulates `agent_message_chunk` text, and resolves to a uniform `{ text, error, sessionId, stopReason, cancelled, modes, configOptions, usage, exitCode }` (error set, never thrown — matching the adapter contract). Permission requests are auto-rejected by default and allowed only with `allowWrites`. Cancellation (`promise.cancel()` or `spec.signal`) sends in-protocol `session/cancel`, waits a 5 s grace, then process-tree-kills the child via the existing `lib/process.mjs` helpers; per the verified cancelled-detection rule, a cancel-requested turn is reported `cancelled: true` regardless of the agent's `stopReason` (OpenCode mislabels cancel as `end_turn`). Inactivity (reset on every `session/update`) and overall watchdogs convert hangs to a `timeout` error and reap the child; a child that dies before the handshake yields a `spawn` error with the stderr tail. A requested model that is absent from the live `configOptions` list fails the turn with a `config` error **before** prompting (no silent fallback). The runner imports only the vendored SDK bundle, node built-ins, and existing lib helpers, and never logs prompt content.
- **Win32-first ACP spawn resolution.** `plugins/multi/scripts/lib/acp/resolve.mjs` exports `resolveOpenCodeAcp()` / `resolveCursorAcp()` returning `{ exe, args }` (or `{ exe: null, detail }` instead of throwing when not found). OpenCode resolves the platform exe under `%APPDATA%\npm\…\opencode-windows-x64\bin` (with a `-baseline` sibling probe); Cursor resolves the bundled `node.exe` + `index.js acp` under the lexically-latest `^\d{4}\.` version dir in `%LOCALAPPDATA%\cursor-agent\versions` (it self-updates in the background). Both honor the existing `OPENCODE_CLI_PATH` / `CURSOR_AGENT_PATH` overrides and fall back to the bare binary name off-win32.
- **Vendored zero-runtime-dependency SDK bundle.** `scripts/build-acp-vendor.mjs` (run via `npm run build:acp-vendor`) esbuild-bundles `@agentclientprotocol/sdk` + its `zod` peer into a single committed ESM file (`plugins/multi/scripts/lib/acp/vendor/acp-sdk.bundle.mjs`, `external: node:*`), so nothing is installed at plugin-install time. The SDK, `zod`, and `esbuild` are devDependencies only. A banner records the bundled SDK version; the build is idempotent (a second run is byte-identical).
- **Offline ACP contract test suite.** `test/unit/acp-client.test.mjs` (27 tests) drives `runAcpTurn` against a fake ACP agent fixture (`test/fixtures/fake-acp-agent.mjs`, raw newline-delimited JSON-RPC over stdio): happy-path streaming order, set_mode / set_config_option, model-not-in-options, permission reject/allow, all three cancel paths (honored, `end_turn`-mislabel, ignored→tree-kill with orphan-liveness assertion), inactivity timeout, child-exit-before-handshake, unknown/tolerated `sessionUpdate` kinds, and a cwd-with-spaces round-trip — plus `resolve.mjs` unit tests (env overrides, missing-binary `{exe:null}`, Cursor version-dir selection) and a drift-gate test asserting the vendor bundle exists, imports, exports `ndJsonStream`/`ClientSideConnection`/`PROTOCOL_VERSION`, and records the SDK version pinned in `package-lock.json`.
- **ACP transport behind per-CLI flags (slices 2 & 3): OpenCode + Cursor adapters can run over ACP instead of headless, opt-in and off by default.** Two env vars select the transport per turn (read at `invoke()` time, not import time, so it can be flipped per case): `MULTI_TRANSPORT_OPENCODE` and `MULTI_TRANSPORT_CURSOR`, each `acp` | `headless` (default `headless`). Selection lives entirely inside each adapter — the adapter contract, registry, companion, commands, and skills are untouched, and **with no flag set the behavior is byte-identical to today (the headless path)**. On the ACP path each adapter calls the slice-1 `runAcpTurn` and maps its options back to the SAME result shape the headless `invoke()` returns (`text`/`error`/`sessionId`/`status`/`fileChanges`/`commandExecutions`/`toolCalls`), so the render layer is unchanged; `session/update` chunks are mapped to the existing `onStream` phase/message_chunk convention. **OpenCode ACP** (`opencode acp`): read-only roles reuse the headless `buildOpencodeSpawnEnv` verbatim (the `OPENCODE_PERMISSION` deny floor — the same constant, not duplicated JSON), and the model passes through as the same `provider/model` id the headless path gives `--model`, pinned via `set_config_option`. **Cursor ACP** (`cursor-agent acp`): read-only roles (research/explore/…) set session mode `ask`, write/delegate set `agent` (writes allowed); the friendly `--model` name is resolved against the LIVE composite-id list from `session/new` (exact match → unique prefix match on the segment before `[`, e.g. `composer-2.5` → `composer-2.5[fast=true]`; ambiguous or no match → a `config` error listing the available ids, no silent fallback). To resolve the composite id pre-prompt without a second session, `runAcpTurn` gained a small `resolveModel(availableIds, requested)` callback (validated after `session/new`, before the prompt). Cancellation routes to the in-flight ACP turn's in-protocol cancel handle (in-process) and reports `transport: "acp"`; the authoritative cross-process cancel remains the companion's process-tree kill (the ACP child sits inside the worker's tree). The headless cancel/SIGTERM paths are untouched and never run on the ACP path.
- **Decoupled the slice-1 ACP layer from the legacy pre-retreat files.** `lib/acp/client.mjs` now imports `sanitizeDiagnosticMessage` from a new `lib/acp/diagnostics.mjs` (the function copied byte-for-byte from the legacy `lib/acp-diagnostics.mjs`, which is left untouched), so the ACP-v2 layer no longer depends on a file slated for deletion.
- **Offline ACP-path tests for both adapters.** New `test/unit/opencode-acp.test.mjs` (16 tests) and `test/unit/cursor-acp.test.mjs` (17 tests) drive each adapter's `invoke()` against the fake ACP agent via an injected `spawnSpec` (the role `resolve.mjs` env overrides serve in production): transport selection honors the env flag and defaults to headless; the OpenCode read-only deny floor + model pass through (asserted via a new `--echo-env` fixture flag); Cursor session mode by role and model alias resolution (exact, prefix-unique, ambiguous→error, missing→error with the list); result-shape parity with the headless path; and cancel routing through the in-flight handle. `acp-client.test.mjs` gains 3 tests for the new `resolveModel` callback. Suite total 204 → **240**.

## 0.1.0 — 2026-06-02

> **Versioning reset.** The project moved to a pre-1.0 `0.x` scheme to reflect that it is in active development; the earlier `v2.0.0`/`v2.0.1` GitHub releases were removed. Entries under **Pre-reset history** below predate this reset and are kept as a record (their version numbers do not continue the `0.x` line).

### Added

- **OpenCode provider.** `/opencode:delegate`, `/opencode:research`, and `/opencode:explore` are now shipped commands. Transport: headless `opencode run --format json`, piped NDJSON. The adapter (`lib/adapters/opencode.mjs`) parses the NDJSON event stream (step_start, text, step_finish, tool_use, error), derives file changes and command executions from completed tool_use events, and delivers the prompt on stdin (newline-safe). Read-only roles (`research`, `explore`) are enforced via injected oc-* primary agents (`OPENCODE_CONFIG_CONTENT`) with write/edit/bash denied plus an `OPENCODE_PERMISSION` deny floor — OpenCode has no `--read-only` flag. Write roles use `--dangerously-skip-permissions`. `--until-done` is supported; `--effort` is not. Default model: `opencode/claude-opus-4-8` (Zen, billed separately). **Token-offload caveat: `anthropic/*` models reuse the Claude Code subscription — zero offload; use `opencode/*`, `openai/*`, `google/*`, `github-copilot/*`, or `ollama/*` for real offload.** MCP servers are read from OpenCode's own `opencode.json` (not managed by `/multi:setup`). Set `OPENCODE_CLI_PATH` to pin a specific binary; set `OPENCODE_CLI_DEFAULT_MODEL` to override the default model. The adapter is registered in `lib/adapters/registry.mjs` and the opencode plugin is listed in `.claude-plugin/marketplace.json`.

- **Reworked the Cursor slice into `/cursor:delegate`, `/cursor:research`, `/cursor:explore`** (replacing `/cursor:execute`, `/cursor:plan`, `/cursor:debug`). `delegate` is agentic implementation (Cursor writes code; the calling Claude thread runs the listed `## Verification` commands), `research` is read-only **external** web/docs research (Cursor's built-in WebSearch with the Exa MCP as a fallback), and `explore` is read-only codebase Q&A (semantic search + grep). All three default to Cursor's `auto` model and accept `--model`. `delegate` also gains the autonomous **`--until-done`** multi-step loop (with `--max-turns`), previously Codex-only — the loop's stop logic is now a shared, transport-agnostic helper (`evaluateAutonomousStop`).
- **Implemented the Antigravity slice on Google's headless `agy` CLI (EXPERIMENTAL).** `/antigravity:research` and `/antigravity:explore` now run read-only against `agy -p` (Gemini 3.5 Flash). Because `agy`'s headless stdout is empty upstream (gemini-cli#27466, unfixed as of agy 1.0.3), the adapter spawns `agy -p`, learns the conversation id from a per-invocation `--log-file`, and recovers the answer from agy's on-disk transcript JSONL (`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`); the last non-empty `PLANNER_RESPONSE` step is the answer. Auth is `agy`'s own OAuth keyring (no API key); the desktop app is not required. Cancel is a process-tree kill. Per-call `--model`, write-`delegate`, and `--until-done` are intentionally unsupported on this path. New pure-helper tests in `test/unit/antigravity-headless.test.mjs` (against captured fixtures).

### Fixed

- **Codex broker leak.** The reused per-cwd app-server broker daemon now self-terminates after an idle window (`CODEX_COMPANION_BROKER_IDLE_MS`, default 600000 ms), so brokers spawned for transient or extra workspaces no longer linger forever (and, on Windows, no longer pin their cwd directory open). The SessionEnd hook already reaped the session's primary-cwd broker; this idle timer is the backstop for every other case (`app-server-broker.mjs`, `lib/broker-lifecycle.mjs` → `shouldIdleShutdown`).
- **Unreachable review-gate toggle / dangling `/codex:setup` references.** `setup` was renamed to `/multi:setup`, but the companion, the Codex adapter, the stop-review-gate hook, the stop-gate prompt, and the `codex-result-handling` skill still pointed users at the non-existent `/codex:setup` — and `/multi:setup` did not expose `--enable-review-gate`/`--disable-review-gate`, so the stop-time review gate could not be toggled from any shipped command. Repointed every reference to `/multi:setup` and taught `/multi:setup` to forward the review-gate flags to the companion (which already implemented the toggle).

### Changed

- **Revamped the `customize` and `multi-cli-anything` skills to match the post-split, headless shape.** Both predated the Cursor ACP→headless migration, the Antigravity headless-`agy` slice, the shared `multi-cli-runtime` forwarding contract, and the companion monolith split — so they documented a `buildPrompt()` role→slash-prefix layer and an `ADAPTERS` map inside `multi-cli-companion.mjs` that no longer exist, and treated ACP as the default integration path. `customize` now teaches the real four moving parts (slash command / forwarder framing block / adapter role→flag map / shared `multi-cli-runtime` contract), the forwarder model-by-role policy (Sonnet for framing roles, Haiku for pure path-bridges), and headless-era escape hatches (`CURSOR_AGENT_PATH`, `AGY_CLI_PATH`, per-CLI MCP config), with `ACP_TRACE` demoted to legacy; its stale `/cursor:research` "add-a-command" example and `cursor-researcher` role name are replaced with current ones. `multi-cli-anything` now leads with headless print-mode (`cursor.mjs`) as the common path, documents spawn-and-read-artifacts (`antigravity.mjs`) and ASP (`codex.mjs`), demotes ACP to a clearly-labeled legacy section, and points registration at `lib/adapters/registry.mjs` and dispatch at `lib/commands/task.mjs` (not the companion). Docs-only; no runtime change.
- **Refreshed the banner and README for the four-CLI lineup.** New banner art (Cursor · Antigravity · OpenCode · OpenAI Codex, replacing the stale gold banner that still showed the removed Copilot/Gemini/Qwen). The "CLIs supported" badge and intro now include OpenCode, with a note that **OpenCode is in active development** (its `/opencode:*` provider commands don't ship yet; today's working providers are Codex, Cursor, Antigravity). Also corrected the README's stale `ACP_TRACE` troubleshooting note — no shipped provider uses ACP.
- **Migrated the Cursor adapter from `agent acp` (ACP JSON-RPC) to headless `agent -p`.** Headless fixes what ACP could not on Windows: MCP/web tools fire (they were silently dead in ACP since ~2026.04.17), cancel is a real process-tree kill (was a no-op), progress is parsed from the documented `stream-json` event stream, and model/mode selection are first-class flags (`--model <flat-name>`, `--mode ask`) instead of post-session RPCs — so the stale bracketed-`modelId` resolution is gone and `auto` is the default. The prompt is delivered on **stdin** (newline-safe). ACP (`lib/acp-client.mjs`) now serves only the antigravity/gemini path. Forwarders run on **Sonnet** (`cursor-delegate`, `cursor-research`) and **Haiku** (`cursor-explore`, a pure read-only path-bridge).
- **Forwarder subagent models tuned by role.** `codex-execute` and `codex-rescue` run on **Sonnet**: they *frame and route* the prompt (choosing model/effort and shaping the task) where a more capable model materially improves the work the external CLI then does — matching the official `codex-plugin-cc` rescue subagent. `codex-review` stays on **Haiku**: it does no framing, only bridging the plugin boundary to forward `review`/`adversarial-review` to the companion, so the cheapest model is the correct one. (The cursor/antigravity forwarders already run on Sonnet.)
- **Repo structure for multi-agent work (no behavior change).** Added `AGENTS.md`/`CLAUDE.md` orientation, `ARCHITECTURE.md`, an explicit adapter `CONTRACT.md`, a zero-dependency offline test suite (`npm test`, Node's built-in runner) with a reusable sandbox fixture, and a gitignored `.agent/` scratch area. Began splitting the companion monolith: extracted the pure task-option normalizers (model alias, reasoning-effort validation, argv splitting) into `lib/task-options.mjs` with characterization tests.
- **Split the two monoliths into focused modules (no behavior change).** `multi-cli-companion.mjs` (1462 lines) is now a ~100-line dispatcher; its command handlers moved verbatim into `lib/commands/{shared,setup,jobs,review,task}.mjs`. `lib/adapters/codex.mjs` (1110 lines) is now a ~30-line re-export barrel over `codex-{roles-prompts,render-parse,transport}.mjs`, keeping the public import surface and the `adapter` object intact. Every function was moved byte-for-byte; the offline suite grew from 27 to **82** characterization tests (all passing), and the live suite plus an adversarial verbatim diff against the prior revision confirm the CLI surface and behavior are unchanged.
- **Antigravity transport: replaced the planned desktop Language Server (ConnectRPC live-attach) with the headless `agy` CLI.** The v3.0.0 stub targeted attaching to the running Antigravity 2.0 desktop app's LS; that approach is dropped — driving the Antigravity desktop/OAuth login from third-party software violates Google's ToS, and Google now ships the standalone `agy` CLI (which runs without the desktop app). The `antigravity.mjs` stub is replaced by a real adapter, `handleCancel` gained an antigravity branch, and `/multi:setup` now points users at installing `agy` and signing in (rather than running the desktop app).

---

## Pre-reset history

_The entries below predate the move to `0.x` versioning and are retained for the record._

## v3.0.0 — 2026-05-24

**Breaking release.** The provider set is now **Codex, Cursor, and Antigravity**. Three providers were removed and command namespaces were reorganized — there is no in-place behavioral compatibility with v2.x for the dropped CLIs. After upgrading, restart Claude Code so the subagent roster refreshes, then re-run `/multi:setup`.

### Removed (breaking)

- **Gemini, Copilot, and Qwen providers** — their plugins, adapters, subagents, and commands are gone. Gemini CLI access was cut during the gap (Gemini CLI sunset); Copilot was dropped after MSFT's billing change; Qwen was unused in practice. The Antigravity provider replaces Gemini-family access via a different transport.
- The Gemini ACP broker lifecycle (`gemini-broker-lifecycle.mjs`) and the `/gemini:*`, `/copilot:*`, `/qwen:*` command surfaces.

### Added

- **Antigravity provider** — `/antigravity:research` (Gemini 3.1 Pro) and `/antigravity:explore` (Gemini 3.5 Flash), both read-only, reached through the running **Antigravity 2.0 desktop app's** Language Server. This release ships a **stub adapter**: process detection works (Windows-first), but the Language Server transport (ConnectRPC live-attach) lands in a follow-up (Phase 2). `/antigravity:*` commands currently return a clean "not implemented (Phase 2)" message; macOS/Linux discovery is also Phase 2.
- **Forked-and-merged the official OpenAI `codex-plugin-cc`** into our `codex` slice: new `/codex:rescue`, `/codex:review`, and `/codex:adversarial-review` commands, the `codex-rescue` and `codex-review` subagents (with disjoint-trigger descriptions so Claude's auto-dispatch stops confusing them), and three vendored helper skills (`codex-cli-runtime`, `gpt-5-4-prompting`, `codex-result-handling`). All routed through our `multi` companion. Attribution recorded in `NOTICE` (Apache-2.0).

### Fixed

- **Latent ENOENT in the review / stop-gate paths.** The companion dispatched `review`/`adversarial-review` and the stop-review-gate hook, but the data files they read (`schemas/review-output.schema.json`, `prompts/adversarial-review.md`, `prompts/stop-review-gate.md`) were missing from the repo, so those paths threw at runtime. Restored the schema and prompt templates.

### Changed

- **Modernized the Cursor adapter.** Model selection now uses `session/set_config_option` (Cursor 2026.04.13+ ignores `session/new.model` and `session/set_model`). Dropped the `~/.cursor/cli-config.json` allowlist injection entirely — the 2026.04.17 MCP/Terminal regression that required it was fixed upstream (forum #155544/#155516). Refreshed the current-model reference list and the known-broken-version warning.
- **Command-namespace policy.** Provider plugins own their own command namespaces (`/codex:*`, `/cursor:*`, `/antigravity:*`); `/multi:*` is reserved for cross-cutting operations (`setup`, `status`, `result`, `cancel`).
- **`/multi:setup` detection** now probes Codex, Cursor, and Antigravity (and reports a running Antigravity desktop) instead of the removed CLIs. The companion's setup report enumerates the live provider set via each adapter's `isAvailable()`.
- **Skills** (`customize`, `multi-cli-anything`, `multi-cli-runtime`, `multi-plan-handoff`, `multi-result-handling`) updated for the new inventory; `multi-cli-anything` now documents Antigravity's non-ACP Language Server (ConnectRPC) transport as a worked example of a non-ACP adapter.

### Migration from v2.x

1. Update the marketplace: `/plugin marketplace update cc-multi-cli-plugin`.
2. Uninstall the dropped provider plugins if you had them: `/plugin uninstall gemini@cc-multi-cli-plugin` (and `copilot`, `qwen`).
3. Reinstall the hub and the providers you want: `/plugin install multi@cc-multi-cli-plugin --force`, then `codex` / `cursor` / `antigravity`.
4. Restart Claude Code (subagent definitions are cached at session start), then run `/multi:setup`.

## v2.0.1 — 2026-04-26

Bug-fix release. Real-world prompts beyond a one-shot text reply silently broke before this — agents stalled, errors vanished, the forwarding subagents reported success on empty output. This release fixes the entire ACP traffic path.

### Fixed

- **ACP session hangs across all CLIs.** The shared ACP client now responds to incoming JSON-RPC requests from the agent (previously dropped). `buildAutoApproveRequestHandler` services `session/request_permission`, `cursor/ask_question`, and the full `terminal/*` family — without these, agents stalled forever waiting for our response.
- **Silently-dropped errors.** Non-codex adapter branches now exit 0 on in-protocol errors (with the failure message in rendered output). Previously, exit 1 tripped the forwarding subagent's "if Bash fails, return nothing" rule and the user saw nothing at all.
- **Cursor `agent acp` Terminal hang.** Plugin now auto-injects a permissive allowlist (`Shell(*)`, `Read/Write/Edit(**)`, `MCP(*)`) into `~/.cursor/cli-config.json` before each Cursor invocation. Without this, Cursor's out-of-band permission gate silently stalls every `execute` tool call.
- **Gemini `--model auto` hang.** Companion now treats `auto` as "skip `session/set_model`" so the CLI's native alias resolver picks a real model id. Calling `set_model("auto")` over ACP was silently accepted but caused `session/prompt` to hang.
- **MCP server schema.** `env` is now an array of `{name, value}` per ACP spec (was a `Record<string, string>`).

### Added

- **MCP wiring (Exa + Context7) into ACP `session/new`** for all four ACP adapters (Gemini, Cursor, Copilot, Qwen). Reads keys from `~/.claude/plugins/cc-multi-cli-plugin/config.json` (already populated by `/multi:setup`).
- **Client-side ACP terminal services** (`scripts/lib/acp-terminals.mjs`) — `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` backed by `child_process.spawn` with a 1 MiB output ring buffer. Handshake declares `clientCapabilities.terminal: true`.
- **Yolo / max-permission defaults.** Gemini approval mode is now always `yolo`; Codex sandbox for `--write` tasks is `danger-full-access`; Cursor spawn includes `--yolo --approve-mcps acp` and explicitly sets ACP mode based on role.
- **`ACP_TRACE=1` env var** for full incoming-message tracing — single most useful diagnostic when an agent silently hangs.
- **One-time stderr warning** when Cursor 2026.04.17-787b533 (the build with the documented MCP/Terminal regression) is detected. Auto-quiet on other versions.
- **Operator escape hatches**: `CURSOR_AGENT_PATH` env var is now honored for pinning a specific Cursor build. Documented in the `customize` skill.

### Changed

- **All 10 multi/agents/*.md** loosened forwarding contract: capture stderr (`2>&1`), forbid ad-hoc polling/sleep/cat, return a structured one-line failure summary on Bash failure (instead of silently returning nothing). `--write` defaults added to writer-style agents (cursor-debugger, cursor-writer, qwen-writer).
- **Skills** (`multi-cli-anything`, `customize`) now document the ACP gotchas we hit empirically — out-of-band permission gates, terminal capability semantics, MCP wiring quirks, mode-setting variance, version sensitivity. `cursor.mjs` is cited as the worked example.
- **README** Known Issues section with documented Cursor 2026.04.17 upstream regressions (forum links).

### Known issues (upstream, not fixable from the plugin)

- Cursor 2026.04.17 `agent acp` does not send `session/request_permission` over the wire and silently stalls Terminal/MCP tool calls. Workaround: pre-approval via `cli-config.json` allowlist (auto-applied) keeps simple shell exec working; complex multi-tool runs may still hang. Pin an older build via `CURSOR_AGENT_PATH` if needed.

## v2.0.0 — 2026-04-24

### Breaking — renamed from `skill-gemini` to `cc-multi-cli-plugin`

This release fully replaces the former `skill-gemini` plugin. The plugin has a new name, a new repo URL (github.com/greenpolo/cc-multi-cli-plugin), a new scope (4 CLI providers, not just Gemini), and new commands. There is no in-place upgrade path.

**Migration from v1 (`skill-gemini`):**
1. In Claude Code: `/plugin uninstall skill-gemini`
2. In Claude Code: `/plugin install cc-multi-cli-plugin` (from github.com/greenpolo/cc-multi-cli-plugin)
3. Run `/multi:setup` to configure MCPs on each CLI
4. The old `skills/gemini` SKILL is gone. Its functionality is absorbed by `/gemini:research` and the `gemini-researcher` subagent.

### Added

**Four CLI transport adapters, three protocols:**
- Codex via App Server Protocol (ASP) — `codex --app-server`
- Gemini via Agent Client Protocol (ACP) — `gemini --acp`
- Cursor via ACP — `agent acp`
- GitHub Copilot via ACP — `copilot --acp --stdio`

**Eight slash commands:**
- `/multi:setup` — one-shot Claude-driven wizard that detects installed CLIs and configures Exa + Context7 MCPs on each
- `/gemini:research` — deep research / exploration with Gemini's 1M-token context (read-only)
- `/codex:execute` — delegate a specific plan step to Codex for rigorous implementation
- `/cursor:write` — bulk / multi-file code writing in Cursor Agent mode
- `/cursor:plan` — Cursor Plan mode for approach design (read-only)
- `/cursor:debug` — Cursor Debug mode for hypothesis-driven root-cause investigation
- `/copilot:research` — Copilot's /research (GitHub + web investigation)
- `/copilot:review` — Copilot's /review code review agent

**Four auto-dispatch subagents** (Claude proactively delegates via the Agent tool):
- `gemini-researcher`, `codex-execute`, `cursor-writer`, `cursor-debugger`

**Two extension skills:**
- `customize` — guides Claude through rewiring which CLI handles which role (swap, disable, restrict, etc.)
- `multi-cli-anything` — guides Claude through adding brand-new CLI providers (ACP, ASP, or subprocess paths)

**Companion runtime** (ported from OpenAI's `codex-plugin-cc`):
- Shared CLI adapter registry with `--cli <name>` dispatch
- Background job control (`--background` / `--wait`)
- Session state persistence under `~/.claude/plugins/cc-multi-cli-plugin/state/`
- Session lifecycle hooks
- Windows-safe `spawn()` pattern for `.cmd`-wrapped CLIs (Cursor, Gemini, Copilot on npm global installs)

### Changed

- Plugin name: `skill-gemini` → `cc-multi-cli-plugin`
- License: unchanged (Apache 2.0) but `LICENSE` and `NOTICE` files added with full upstream attribution
- Repo layout: flattened from marketplace format (`plugins/skill-gemini/`) to a single-plugin layout at the repo root

### Removed

- The old Gemini-only `skills/gemini/SKILL.md` — functionality absorbed by `gemini-researcher` + `/gemini:research`
- The repo's former `plugins/skill-gemini/` nested directory
- The former `.claude-plugin/marketplace.json` marketplace manifest

### Known limitations

These are explicit v2.0.0 deferrals. Filed for a future release.

- **Background task worker untested for non-Codex CLIs.** The `cli` field is stored in the job request and threaded through `executeTaskRun`, so Gemini/Cursor/Copilot background jobs *should* work — not yet verified end-to-end.
- **`--resume-last` is Codex-only.** Gemini/Cursor/Copilot receive the flag but have no session-resumption logic wired to the adapter. Per-invocation ACP sessions work; cross-invocation resume does not yet.
- **`job-observability` integration** between the shared runtime and non-Codex adapters is partial. `recordObserverEvent` is a no-op in the Gemini/Cursor/Copilot paths. Doesn't affect correctness, does affect introspection.
- **`/codex:review` and `/codex:adversarial-review`** remain in the official `openai-codex` plugin; our plugin has no review path for non-Codex CLIs yet. Gemini/Cursor/Copilot reviews can be invoked through each CLI's native slash command via the companion runtime but not through top-level plugin commands.
- **Setup wizard's MCP probes.** `/multi:setup` configures MCPs on each CLI but doesn't deeply verify Exa / Context7 are reachable after configuration. Users should do a sanity check by running `/gemini:research test` or similar after setup.

### Attribution

Apache 2.0 licensed. Major portions derived from:

- OpenAI's `codex-plugin-cc` (Apache 2.0) — runtime architecture, Codex adapter, hooks
- `sakibsadmanshajib/gemini-plugin-cc` (Apache 2.0) — Gemini ACP transport pattern
- `blowmage/cursor-agent-acp-npm` (MIT) — Cursor ACP adapter reference

See [NOTICE](NOTICE) for the full attribution.

## v1.0.0 — 2026-03 (as `skill-gemini`)

Original Gemini-only read-only consultation skill. See `v1.0.0` git tag for history. Superseded by v2.0.0.

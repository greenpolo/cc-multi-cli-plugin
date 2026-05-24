# Changelog

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

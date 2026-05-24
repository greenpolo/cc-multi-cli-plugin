![cc-multi-cli-plugin](docs/assets/banner.png)

# cc-multi-cli-plugin

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/greenpolo/cc-multi-cli-plugin?include_prereleases&sort=semver&label=release)](https://github.com/greenpolo/cc-multi-cli-plugin/releases)
[![Built for Claude Code](https://img.shields.io/badge/built_for-Claude_Code-d97757)](https://docs.anthropic.com/en/docs/claude-code)
[![CLIs supported](https://img.shields.io/badge/CLIs-Codex_·_Cursor_·_Antigravity-555)](#commands)
[![Stars](https://img.shields.io/github/stars/greenpolo/cc-multi-cli-plugin?style=social)](https://github.com/greenpolo/cc-multi-cli-plugin/stargazers)

If you have access to multiple AI coding CLIs (Codex, Cursor, Antigravity), this plugin lets Claude Code delegate to whichever one is best for the task — without you having to switch tools or run them yourself.

Each CLI is wired up through its native transport (Codex via ASP, Cursor via ACP, Antigravity via the Antigravity 2.0 desktop Language Server). This lets you pick and choose the best features from each — like `/cursor:debug` for hypothesis-driven debugging, `/codex:review` for code review, or `/antigravity:research` for deep research. Sessions, streaming, tool calls, and background jobs all work normally.

## Install

Paste into Claude Code:

```
/plugin marketplace add https://github.com/greenpolo/cc-multi-cli-plugin
/plugin install multi@cc-multi-cli-plugin
/multi:setup
```

`/multi:setup` detects which CLIs you have, installs the matching sub-plugins, and wires Exa + Context7 MCPs into each.

## Skills Included:

Two skills ship with the plugin:

- **multi-cli-anything** — adds ANY CLI (Aider, OpenCode, anything that speaks ACP, ASP, or a structured RPC transport) as a subagent that Claude can invoke at will. Claude scaffolds the new plugin in the marketplace.

- **customize** — change which CLI handles what. *"Make Codex the executor instead of Cursor."* Claude does the file edits, reinstalls, and tells you what restarts are needed.

Just ask Claude in plain English. The skills activate automatically.

## Commands

Provider commands live under each CLI's namespace; the cross-cutting `/multi:*` commands operate the shared runtime.

| Command | What it does |
|---|---|
| `/codex:execute` | Delegate a specific plan or plan step to Codex |
| `/codex:rescue` | Hand a stuck or open-ended problem to Codex for an independent investigation |
| `/codex:review` | Codex code review of your working tree or a branch (read-only) |
| `/codex:adversarial-review` | Adversarial design/code review — challenges the approach, not just the diff (read-only) |
| `/cursor:execute` | Delegate a plan or plan step to Cursor (Agent mode) |
| `/cursor:plan` | Ask Cursor to design an approach (Plan mode, read-only) |
| `/cursor:debug` | Hand a hard bug to Cursor's hypothesis-driven Debug mode |
| `/antigravity:research` | Deep external research with Antigravity (Gemini 3.1 Pro, read-only) |
| `/antigravity:explore` | Fast codebase exploration with Antigravity (Gemini 3.5 Flash, read-only) |
| `/multi:setup` | One-shot wizard — detects CLIs, configures Exa + Context7 MCPs |
| `/multi:status` | Show active and recent background jobs for this repo |
| `/multi:result` | Show the stored final output for a finished job |
| `/multi:cancel` | Cancel an active background job |

Claude can also auto-dispatch the provider commands without you typing them.

All of them are interchangeable, and can be altered to whatever you want using the `customize` skill.

## Known issues

These are upstream CLI quirks and current limitations. If you hit something not listed, set `ACP_TRACE=1` and check stderr — that reveals which JSON-RPC traffic is or isn't crossing the wire (ACP CLIs only; Antigravity does not use ACP).

- **Cursor `agent acp` 2026.04.17 — Terminal/MCP regression (FIXED upstream).** Older builds could stick the `Terminal` (execute) tool at `in_progress` forever and silently fail MCP tools. This was fixed in Cursor 2026.04.13+ (forum #155544/#155516), so the plugin no longer injects a `cli-config.json` allowlist. If you're stuck on a broken build, pin a known-good one: `export CURSOR_AGENT_PATH=<path-to-good-build>`. ([forum](https://forum.cursor.com/t/cursor-agent-cli-mcp-tool-calls-silently-stopped-working-in-2026-04-17/158988))

- **Cursor `agent acp` — `mcpServers` ignored.** MCP servers passed via ACP `session/new` are silently dropped in `agent acp` mode (per Cursor staff). The plugin falls back to Cursor's own `~/.cursor/mcp.json`. ([forum](https://forum.cursor.com/t/mcp-servers-passed-via-session-new-dont-work-in-acp-mode/153823))

- **Cursor model selection via `session/set_config_option`.** Cursor 2026.04.13+ ignores model hints in `session/new` and `session/set_model`; the adapter sets the model with `session/set_config_option` after the session exists. ([forum #157312](https://forum.cursor.com/))

- **Antigravity requires the desktop app to be running.** Antigravity has no command-line binary — it is reached by attaching to the running **Antigravity 2.0 desktop app's** Language Server. You must install Antigravity (https://antigravity.google), sign in, and keep the app open; `/multi:setup` reports whether it's detected. If the desktop isn't running, `/antigravity:*` commands report "not detected."

- **Antigravity transport is Phase 2 / Windows-first.** This release ships a **stub** Antigravity adapter: detection works (Windows process discovery), but the Language Server transport (ConnectRPC live-attach) is not implemented yet, so `/antigravity:*` commands return a clean "not implemented (Phase 2)" message. macOS/Linux discovery also lands in Phase 2.

When upstream CLIs change behavior, the plugin's adapters absorb it — these notes track the current state.

## License

Apache 2.0. See [NOTICE](NOTICE) for upstream credits.

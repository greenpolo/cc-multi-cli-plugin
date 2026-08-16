![cc-multi-cli-plugin](docs/assets/banner.png)

# cc-multi-cli-plugin

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/greenpolo/cc-multi-cli-plugin?include_prereleases&sort=semver&label=release)](https://github.com/greenpolo/cc-multi-cli-plugin/releases)
[![Built for Claude Code](https://img.shields.io/badge/built_for-Claude_Code-d97757)](https://docs.anthropic.com/en/docs/claude-code)
[![CLIs supported](https://img.shields.io/badge/CLIs-Codex_·_Cursor_·_Antigravity_·_OpenCode-555)](#commands)
[![Stars](https://img.shields.io/github/stars/greenpolo/cc-multi-cli-plugin?style=social)](https://github.com/greenpolo/cc-multi-cli-plugin/stargazers)

If you have access to multiple AI coding CLIs (Codex, Cursor, Antigravity, and OpenCode), this plugin lets Claude Code delegate to whichever one is best for the task — without you having to switch tools or run them yourself.

Each CLI is wired up through its native transport (Codex via ASP, Cursor via headless `agent -p`, Antigravity via its headless `agy` CLI, OpenCode via headless `opencode run --format json`). Cursor and OpenCode can also run over **ACP** (Agent Client Protocol) as an opt-in — see [Transports](#transports). This lets you pick and choose the best features from each — like `/cursor:delegate` for fast implementation, `/codex:review` for code review, `/antigravity:research` for deep research, or `/opencode:delegate` to offload implementation to OpenCode's Zen models. Sessions, streaming, tool calls, and background jobs all work normally.

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

- **multi-cli-anything** — adds ANY CLI beyond the four built-in providers (Aider, Qwen, or anything with a headless/print, app-server, or structured transport) as a subagent that Claude can invoke at will. Claude scaffolds the new plugin in the marketplace.

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
| `/cursor:delegate` | Delegate an implementation task or plan step to Cursor (agentic; writes code; supports `--until-done`) |
| `/cursor:research` | Read-only external web/documentation research via Cursor |
| `/cursor:explore` | Read-only codebase exploration via Cursor |
| `/antigravity:research` | Deep external research with Antigravity (Gemini 3.7 Flash, read-only; experimental) |
| `/antigravity:explore` | Fast codebase exploration with Antigravity (Gemini 3.7 Flash, read-only; experimental) |
| `/opencode:delegate` | Delegate an implementation task to OpenCode (agentic; writes code; supports `--until-done`; default model: opencode/claude-opus-5 via Zen) |
| `/opencode:research` | Read-only external web/documentation research via OpenCode |
| `/opencode:explore` | Read-only codebase exploration via OpenCode |
| `/multi:setup` | One-shot wizard — detects CLIs, configures Exa + Context7 MCPs |
| `/multi:status` | Show active and recent background jobs for this repo |
| `/multi:result` | Show the stored final output for a finished job |
| `/multi:cancel` | Cancel an active background job |

Claude can also auto-dispatch the provider commands without you typing them.

All of them are interchangeable, and can be altered to whatever you want using the `customize` skill.


## Transports

Each CLI is driven over a transport. The defaults are stable and need no configuration; the ACP path is opt-in.

- **Codex** → ASP (app-server behind a broker). **Antigravity** → headless `agy` (transcript read-back).
- **Cursor** and **OpenCode** → headless print mode **by default**, with an optional **ACP** path (Agent Client Protocol — structured JSON-RPC over stdio, via the official `@agentclientprotocol/sdk`). ACP adds in-protocol model selection, session modes, and `session/cancel`; it's still in bake-in, so headless remains the default.

Opt into ACP per CLI with environment variables (e.g. in `~/.claude/settings.json` under `env`):

```json
"env": {
  "MULTI_TRANSPORT_CURSOR": "acp",
  "MULTI_TRANSPORT_OPENCODE": "acp"
}
```

Each is `acp` | `headless` (default `headless`). With no flag set, behavior is identical to before. Codex and Antigravity have no ACP path (Codex has no native ACP; `agy` doesn't implement it). When on the ACP path, `ACP_TRACE=1` traces the JSON-RPC wire to stderr.

## Known issues

These are upstream CLI quirks and current limitations. If you hit something not listed, check the companion's stderr (the forwarders append `2>&1`) — a bad model id, an auth failure, or a sandbox block surfaces there.

- **Cursor runs in headless `agent -p` mode by default** (ACP is opt-in — see [Transports](#transports)). On the headless path the adapter delivers the prompt on stdin, selects the model with `--model` (default `auto`), and parses `json`/`stream-json` output. MCP servers come from Cursor's own `~/.cursor/mcp.json`, which `/multi:setup` maintains (this holds on the ACP path too — the adapter passes no MCP servers in-protocol, so Cursor reads its own config either way).

- **Cursor's shell is slow/unreliable on Windows.** Cursor's terminal tool can stall or wait out a per-command timeout on Windows (host-PATH/WSL, open upstream). So `/cursor:delegate` does **not** run build/test verification itself — it lists the commands in a `## Verification` block and Claude runs them. File writes and web/codebase reads are unaffected.

- **Antigravity runs via the headless `agy` CLI (experimental).** Install the `agy` CLI (https://antigravity.google) and run `agy` once interactively to sign in — the desktop app is **not** required. `/multi:setup` reports whether `agy` is detected.

- **Antigravity reads its answer from a transcript, not stdout.** `agy`'s headless print mode (`agy -p`) currently emits nothing to stdout when piped (an upstream bug, google-antigravity/antigravity-cli#318; `--output-format stream-json` (agy >=1.1.8) is the coming workaround), so the adapter recovers the model's answer from `agy`'s on-disk conversation transcript. Consequences: read-only `research`/`explore` only (no write-`delegate`), the model is fixed to **Gemini 3.7 Flash** (no per-call `--model`), and there are no token-usage metrics on this path. This is a deliberate workaround pending the upstream stdout fix.

- **OpenCode has no `--read-only` flag.** For read-only roles (`/opencode:research`, `/opencode:explore`), the adapter enforces read-only by injecting a custom primary agent via `OPENCODE_CONFIG_CONTENT` with write/edit/bash denied, plus an `OPENCODE_PERMISSION` deny floor. A stale bun `opencode.exe` may shadow the npm `.cmd` shim on Windows — the adapter never resolves to `opencode.exe`; set `OPENCODE_CLI_PATH` to force the right binary if needed.

- **OpenCode token offload: `anthropic/*` models = zero offload.** Calling OpenCode with an `anthropic/*` model routes through the same Claude subscription as Claude Code — no cost savings. Use `opencode/*` (Zen), `openai/*`, `google/*`, `github-copilot/*`, or `ollama/*` models for real offload. The adapter default is `opencode/claude-opus-5` (Zen, billed separately). Override with `OPENCODE_CLI_DEFAULT_MODEL`.

- **OpenCode `--effort` is not supported.** The `--effort` flag is Codex-only; OpenCode ignores it. `--until-done` is supported.

- **OpenCode MCP servers are not managed by `/multi:setup`.** OpenCode reads MCP configuration from its own `opencode.json`; use OpenCode's interactive wizard to wire Exa/Context7 there.

When upstream CLIs change behavior, the plugin's adapters absorb it — these notes track the current state.

## License

Apache 2.0. See [NOTICE](NOTICE) for upstream credits.

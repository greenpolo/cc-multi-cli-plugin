# OpenAI

GPT models run through the official Codex CLI, the way Antigravity and Grok run through
theirs. Each turn starts `codex app-server` (the same interface the Codex IDE extension
and desktop app use), continues the session's Codex thread, and streams Codex's answer
and actions back into Claude Code. Codex runs its own tools, prompts, caching and
compaction, so GPT behaves and spends quota as it does in Codex itself.

## Setup

1. Install the Codex CLI (`npm install -g @openai/codex`) and the core and OpenAI
   plugins. See [docs/installation.md](installation.md).
2. Run `/multi-openai:login`, which runs `codex login`, or run `codex login` yourself.
3. Relaunch the session so the model picker and workers load.

Codex owns the login, where it stores it, and its renewal. Multi never reads the
credentials. Run `codex login` when Codex reports that the login expired.

## Models and effort

The `/model` rows are the models Codex itself lists (`model/list`), with Codex's default
first: today `gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6.1-terra`, `gpt-6.1-sol`, `gpt-6-astra`,
`gpt-6-sol`, `gpt-6-luna` and older ones. A new Codex release brings its new models with
no Multi update. Use `/model multi/openai/<model-id>` or choose a row.

`/effort` applies, checked against what the model supports in Codex; `auto` leaves
Codex's own default.

## Workers

The Agent tool's `OpenAI` type runs any of these models: pass `model: <id>` (for example
`model: gpt-6-luna`), or omit it to run Codex's default model. Workers apply the session's
`/effort`, as Cursor, Antigravity and Grok workers do. Each worker and each main session
keeps its own Codex thread, stored by Codex under its home (`~/.codex`), so a later turn
sends only what is new.

## What changes when GPT is the main model

Codex runs the turn, so GPT uses Codex's own shell, patch, web search, MCP servers,
plugins, skills and subagents, and reads the repository's `AGENTS.md` itself. It does not
use Claude Code's tools, skills, plugins, hooks or Agent tool. Codex's actions appear as
rows under Codex's own names (`shell`, `apply_patch`, `mcp_tool`, ...). Esc-Esc rewind does
not undo Codex's edits; Multi never rewinds native state.

## Permissions

Codex never asks for approval in a Multi run and runs no reviewer.

| Claude mode or rule | Codex run |
| --- | --- |
| Plan | Read-only sandbox, Codex MCP servers off |
| Any other mode | Full access, as Claude's Bypass |
| Edit and Write both removed | Read-only sandbox |
| WebSearch removed | Codex web search off |
| `mcp__server` denied | That Codex MCP server off, when Codex has one by that name |
| `mcp__server__tool` denied | That tool off on that Codex server |
| A tool list naming no MCP tool | Every Codex MCP server off |

Codex has no separate switch for its shell, or for only one of Edit and Write; the run
says so in a one-line notice and goes ahead. See [docs/permissions.md](permissions.md).

## Usage

The usage pane reads Codex's quota windows from the same app-server
(`account/rateLimits/read`). Per-turn tokens come from Codex's own counts, cached input
included. A spent window fails the turn with Codex's own message.

`npm run test:live:codex` checks a write, a resumed read, a Plan turn and a free replay
with three small turns on `gpt-6-luna`.

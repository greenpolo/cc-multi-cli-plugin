![multi-cli — plugin for claude code](docs/assets/banner.svg)

# cc-multi-cli-plugin

**One Claude Code session. Your models. Their native tools.**

[![CI](https://github.com/greenpolo/cc-multi-cli-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/greenpolo/cc-multi-cli-plugin/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/greenpolo/cc-multi-cli-plugin?include_prereleases&sort=semver&label=release)](https://github.com/greenpolo/cc-multi-cli-plugin/releases)
[![Built for Claude Code](https://img.shields.io/badge/built_for-Claude_Code-d97757)](https://docs.anthropic.com/en/docs/claude-code)
[![Node 24.12+](https://img.shields.io/badge/Node-%E2%89%A524.12-555)](#install)
[![Linux · macOS · Windows](https://img.shields.io/badge/platforms-Linux_%C2%B7_macOS_%C2%B7_Windows-555)](docs/platform-support.md)
[![Stars](https://img.shields.io/github/stars/greenpolo/cc-multi-cli-plugin?style=social)](https://github.com/greenpolo/cc-multi-cli-plugin/stargazers)

Multi brings external models and coding harnesses into one Claude Code session through the `/model` picker and provider workers started from the Agent tool, with each provider's own login and permissions. Providers are OpenAI (ChatGPT via Codex login), Cursor (official SDK), OpenCode Zen (API key), Antigravity (official CLI), and Grok (official Grok Build CLI).

[Quick start](#install) · [Providers](#providers) · [Documentation](#documentation) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

![Illustration of Fable 5.1 coordinating GPT-5.6 Luna, Grok 4.6, and Gemini 3.8 Flash workers](docs/assets/multi-provider-workers.svg)

*Illustration of the multi-provider workflow, edited from a live Luna terminal capture; not a recording of a mixed-provider run. [Asset provenance](docs/assets/README.md#multi-provider-worker-showcase).*

## Why Multi?

- **Choose your model in place.** Switch through `/model` and select supported reasoning effort with `/effort`.
- **Delegate to provider workers.** Run a provider's own model from the Agent tool (`OpenAI`, `Cursor`, `Zen`, `Antigravity`, `Grok`); native actions appear as tool rows under the harness's own tool names.
- **Keep native execution.** Zen uses Claude Code's tools; OpenAI (through the Codex CLI), Cursor, Antigravity and Grok run their own CLI or SDK tools.
- **Carry your session forward.** Resume saved sessions, and keep Remote Control when signed in to claude.ai.
- **Terminal or desktop.** Works in `claude-multi` and in the Claude desktop app's Code tab.
- **Stay in control.** Claude's permission mode and explicit tool restrictions govern provider dispatch.

## Install

In Claude Code, add the marketplace and install the providers you want:

```text
/plugin marketplace add greenpolo/cc-multi-cli-plugin
/plugin install multi-openai@cc-multi-cli-plugin
/plugin install multi-cursor@cc-multi-cli-plugin
/plugin install multi-zen@cc-multi-cli-plugin
/plugin install multi-antigravity@cc-multi-cli-plugin
/plugin install multi-grok@cc-multi-cli-plugin
/reload-plugins
/multi-core:setup
```

Install any subset; each provider pulls in the shared `multi-core` plugin. Open a new terminal, run `claude-multi`, and connect the providers you installed:

### Providers

| Plugin | Command | What it gives you |
| --- | --- | --- |
| `multi-openai` | `/multi-openai:login` | [ChatGPT models through Codex](docs/openai.md) |
| `multi-cursor` | `/multi-cursor:login` | [Official Cursor SDK models and workers](docs/cursor.md) |
| `multi-zen` | `/multi-zen:connect` | [OpenCode Zen models with an API key](docs/zen.md) |
| `multi-antigravity` | `/multi-antigravity:connect` | [Antigravity models and workers through `agy`](docs/antigravity.md) |
| `multi-grok` | `/multi-grok:login` | [Grok models and workers through Grok Build](docs/grok.md) |

`multi status` shows installed/enabled providers; it does not test login or inference. `multi uninstall` removes the shell integration and keeps provider logins. Plain `claude` stays unchanged unless you explicitly choose `--command claude`. Rename the launch command or trim the `/model` rows with `/multi-core:setup --command <name> --models <ids>`. Details: [installation](docs/installation.md).

<details>
<summary>Installing with a coding agent</summary>

Paste this into any coding agent:

> Install cc-multi-cli-plugin by following https://github.com/greenpolo/cc-multi-cli-plugin/blob/main/docs/installation.md#for-agents. Ask which providers I want, what to name the launch command (default `claude-multi`), and which models to show in `/model` (curated provider defaults). Hand browser logins and API-key entry to me, and never ask for credentials in chat.

</details>

## Use

Launch with `claude-multi`. `/model` lists the external models next to Claude's; `/effort` sets effort where the model supports it. Provider workers run as subagents with live progress, elapsed time and cancellation; the Agent tool's `model` parameter picks which model of that provider runs. Claude's permission mode governs every provider; see [permissions](docs/permissions.md). Resume a saved session with `claude-multi --resume <session-id>`.

In the Claude desktop app, just start a new Code session after `/multi-core:setup`: Multi starts with it. Workers show there as `multi-core:OpenAI` and so on. See [installation](docs/installation.md#claude-desktop-app).

Use `/multi-usage` to open a provider usage menu with quotas, billed spend where
available, session tokens, and worker receipts. Set `MULTI_RECEIPTS_FILE` before
launching to append JSONL receipts. See [usage and receipts](docs/usage.md).

## Documentation

- [Installation](docs/installation.md), [usage and receipts](docs/usage.md), [permissions](docs/permissions.md)
- Providers: [OpenAI](docs/openai.md) · [Cursor](docs/cursor.md) · [OpenCode Zen](docs/zen.md) · [Antigravity](docs/antigravity.md) · [Grok](docs/grok.md)
- [Platform support](docs/platform-support.md) (Linux, macOS, Windows; WSL uses the Linux paths)
- Contributors: [architecture](ARCHITECTURE.md), [Claude Mods reference](docs/claude-mods.md)

<details>
<summary>Where do tools run?</summary>

Zen uses Claude Code's tool execution loop. OpenAI runs through the Codex CLI, Cursor uses its official SDK, and Antigravity and Grok use their real CLIs. Native harness actions are displayed in the session and are never replayed as executable Claude tool calls. See [architecture](ARCHITECTURE.md) and [permissions](docs/permissions.md) for the boundaries.

</details>

## Contributing

Bug reports, provider improvements, and documentation fixes are welcome. Read the
[contributing guide](CONTRIBUTING.md) for local setup and checks, or open a
[bug report](https://github.com/greenpolo/cc-multi-cli-plugin/issues/new?template=bug_report.yml) or
[feature request](https://github.com/greenpolo/cc-multi-cli-plugin/issues/new?template=feature_request.yml).

CI runs `npm run check` on Linux, macOS, and Windows.

## License

Apache 2.0. See [NOTICE](NOTICE) for upstream credits.

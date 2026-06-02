# Privacy Policy — cc-multi-cli-plugin

_Last updated: 2026-04-26_

## TL;DR

**The plugin itself collects nothing.** It runs entirely on your machine, has no server, no telemetry, no analytics, and no phone-home. The only data that ever leaves your computer goes to the third-party AI CLIs (Codex, Cursor, Antigravity, OpenCode) and MCP servers (Exa, Context7) **that you explicitly invoke** — and only when you invoke them. Each of those services has its own privacy policy that governs what they do with your prompts.

## What the plugin does not do

- Does not collect or transmit telemetry, analytics, or usage data of any kind
- Does not "phone home" to any server operated by the plugin author
- Does not log, store, or transmit your prompts beyond what you explicitly request (i.e., when you invoke a CLI, your prompt goes to that CLI)
- Does not have user accounts, profiles, or persistent identifiers

## What gets stored on your machine

The plugin stores the following on your local disk only:

- **Plugin config** at `~/.claude/plugins/cc-multi-cli-plugin/config.json` — API keys you provided for Exa and Context7 MCP servers (so the plugin can wire them into the CLIs that need them).
- **Per-CLI state** at `~/.claude/plugins/cc-multi-cli-plugin/state/<workspace-hash>/` — job records (job IDs, statuses, working directories, log file paths) for background tasks the plugin tracks. This is local-only state used to support `/codex:status`, `/codex:result`, etc.
- **Job log files** at `~/.claude/plugins/cc-multi-cli-plugin/state/<workspace-hash>/logs/` — stderr output from companion jobs, retained for diagnostics.
- **Cursor allowlist additions** to `~/.cursor/cli-config.json` — the plugin appends permissive entries (`Shell(*)`, `Read/Write/Edit(**)`, `MCP(*)`) so Cursor's permission gate doesn't stall in headless ACP mode. You can edit, tighten, or remove these entries at any time; the plugin only ever appends, never overwrites your existing entries.

You can delete any or all of these directories at any time. The plugin will recreate the structures it needs on next use.

## What goes to third parties

When you invoke one of the plugin's commands or subagents, your prompt is forwarded to the relevant CLI. That CLI then communicates with its provider's servers per **its own** privacy policy:

| CLI / service | Provider | Their privacy policy |
|---|---|---|
| `/codex:execute`, `/codex:review`, `/codex:adversarial-review`, `/codex:rescue` | OpenAI | https://openai.com/policies/privacy-policy |
| `/cursor:delegate`, `/cursor:research`, `/cursor:explore` | Cursor (Anysphere) | https://cursor.com/privacy |
| `/antigravity:research`, `/antigravity:explore` | Google | https://policies.google.com/privacy |
| `/opencode:delegate`, `/opencode:research`, `/opencode:explore` | OpenCode (SST) / configured model provider | https://opencode.ai/docs (and the routed provider's policy) |
| Exa MCP (web search) | Exa | https://exa.ai/privacy-policy |
| Context7 MCP (library docs) | Upstash | https://upstash.com/privacy |
| Claude Code itself | Anthropic | https://www.anthropic.com/legal/privacy |

The plugin is a routing layer — it does not see, transform, or retain prompts beyond passing them to the CLI you chose. Each provider determines what they store and for how long.

## Your rights / removing data

To delete all local data the plugin keeps:

```
# Linux / macOS
rm -rf ~/.claude/plugins/cc-multi-cli-plugin

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\plugins\cc-multi-cli-plugin"
```

To uninstall the plugin entirely, run `/plugin uninstall multi@cc-multi-cli-plugin` (and the per-CLI plugins) inside Claude Code.

For data retention or deletion at the **third-party providers** above, follow each provider's own data-deletion process — the plugin author has no access to those systems.

## Open source

The plugin source is licensed Apache 2.0 and available at https://github.com/greenpolo/cc-multi-cli-plugin. Anyone can audit exactly what the plugin does. If you find behavior that contradicts this policy, please open an issue.

## Changes to this policy

If the plugin's data-handling behavior ever changes, this file will be updated and the change will be noted in the [CHANGELOG](CHANGELOG.md). The "Last updated" date at the top reflects the most recent revision.

## Contact

Open an issue at https://github.com/greenpolo/cc-multi-cli-plugin/issues for any privacy-related question or concern.

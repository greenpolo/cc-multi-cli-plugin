# Permissions

Claude Code's permission mode reaches every provider. Select it before the prompt or worker starts.

## One permission control

Claude Code's permission mode is the single control at prompt boundaries. Direct
models retain Claude's permission checks. Native harnesses run under every mode:

| Claude mode | Native run |
| --- | --- |
| Plan | Read-only: shell and edit capabilities are removed. |
| Bypass | The provider's own review is off; explicit tool restrictions still apply. |
| Auto, acceptEdits | The provider's Auto (Grok keeps its own acceptEdits). |
| Default, dontAsk, anything else | Runs as Auto, and the run opens with a one-line notice saying so. |

Auto does not imply a reviewer exists. Zen, Antigravity and Grok have none:
actions run unreviewed, and the status line says "no auto mode: actions run
unreviewed". Cursor reviews its own native actions and fails open when its
classifier is unavailable.
Claude ask rules remain part of Claude's own tool permission checks.

The gateway keeps one record per session: the mode, workspace and model of the
latest prompt. A worker adds its agent type's own tool rules and inherits the rest,
except that a session in Plan keeps every worker in Plan, including one spawned
earlier and resumed later. OpenAI automatic review reads
`classifier_context.permission_mode` in each model request, so the request itself
determines Plan restrictions.

## The CLI's own tools

A native CLI keeps its own setup: its MCP servers, subagents, scheduling and other
tools that no Claude tool maps to. Multi never copies Claude's plugins or MCP servers
into it, and never hard-blocks the CLI's own. Those tools follow Claude's mode:

| Claude mode | The CLI's own tools |
| --- | --- |
| Bypass, Auto | Run, unless a Claude rule denies them. MCP calls are matched against Claude's MCP deny rules (`mcp__server`, `mcp__server__*`, `mcp__server__tool`) where the CLI names the server and tool. |
| Plan | Left out: only read, search and web lookup run. |

An explicit tool list (an agent type's `tools`, or `--tools`) admits only the tools it
names, `mcp__` entries included. Antigravity matches each MCP call by server and tool;
Grok's rule is coarse, so any MCP deny rule there turns off all of its MCP. Cursor
runs still load no Cursor MCP servers or settings.

## Settings a native harness cannot enforce

A native harness runs its own tools, so Claude Code cannot apply its rules to each
action. What has a native form carries over on every run: bare tool denials
(`"deny": ["Bash"]`), MCP denials (`"deny": ["mcp__minecraft"]`), `--tools` and `--disallowedTools`, and an agent type's `tools`
and `disallowedTools`. What has none is skipped, never refused: ask rules, sandbox
settings, and argument-specific deny rules such as `Bash(rm:*)`. The run opens with
one line naming what was skipped. A rule for a tool the harness does not have
restricts nothing there and is ignored.

## Provider enforcement

| Provider or action | What enforces the permission |
| --- | --- |
| OpenAI direct models | Claude Code's Read, Grep, Glob, Bash, Edit, and Write tools run the tool loop. The originating OpenAI account reviews tool uses inline before the reply completes. Read-only tools on the core skip list need no review. Reviewer failure or timeout refuses the action; discovery failure at launch leaves Auto unreviewed, with that statement in the status line. |
| Zen direct models | Claude Code runs and authorizes the tools. Zen auto mode is unreviewed like bypass; plan mode refuses actions that need review. Zen has no independent reviewer and never uses the OpenAI reviewer. |
| Cursor native harness | Native review belongs to the originating Cursor account and run. Cursor receives the prompt-boundary mode and capability restrictions. See [docs/cursor.md](cursor.md). |
| Antigravity native harness | A namespaced global pre-tool hook enforces Claude's denials while the native CLI runs. See [docs/antigravity.md](antigravity.md). |
| Grok native harness | Each run carries Claude's mode, a bounded native toolset and deny rules that outrank every mode; the announced toolset is checked against the policy. See [docs/grok.md](grok.md). |
| Claude tools | Claude's native permission checks and Anthropic classification apply. |

Claude's `PreToolUse` and `PermissionRequest` hooks govern Claude-executed tools,
not each action inside a native harness; the harness's own policy enforces those.
Native actions appear as display rows that grant nothing and are never replayed as
Claude tools. Several workers of one provider can start together, and a worker the
Agent tool did not announce (one a Workflow started, say) inherits the session's
record and its agent type's tool rules.

## Gateway verdicts

For every reply the gateway serves, it supplies the safety verdict for each tool call
itself, so Claude's own classifier is never billed for an external model's tools.
Read-only and coordination tools (Read, Glob, Grep, ToolSearch, TodoWrite, Agent,
AskUserQuestion and similar) pass without review in every mode. A worker's handback
report reaches its parent without a second review. These verdicts never override
Claude's explicit deny rules. Details are in [ARCHITECTURE.md](../ARCHITECTURE.md#permissions).

## Explicit failures

An unknown model, an unknown provider, or a provider that is not connected fails with a plain message. A permission mode or a Claude setting never does. If the OpenAI reviewer is unavailable at launch, Auto remains available and actions run unreviewed. Plan refuses actions without a reviewer. Once a reviewer is enabled, a failed or timed-out review, malformed evidence, or unavailable evidence produces a `flagged` verdict with a plain explanation. The gateway never substitutes Claude or the working model for the account reviewer.

## Without Anthropic credentials

The launcher keeps Auto available for external models even when Claude is signed
out. Gateway-served tools receive provider verdicts; Claude inference and any
Claude-only classifier request are refused locally with "Anthropic is not signed
in", without forwarding or borrowing another provider's credentials.

A few Claude-only checks outside the gateway (for example AskUserQuestion
auto-answer or sandbox network classification) can still show a dialog or deny in a
signed-out session; sign in to Claude for those.

## Managed policy sources

Each native run reads the selected settings files, so an edit applies to the next run. The managed policy is read once per session. Managed settings use the following locations.

| Platform | Managed sources |
| --- | --- |
| Linux | `/etc/claude-code/managed-settings.json` and JSON files in `/etc/claude-code/managed-settings.d/` |
| WSL | The Linux source: `/etc/claude-code/managed-settings.json` and `/etc/claude-code/managed-settings.d/` |
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json`, JSON files in `managed-settings.d`, and `defaults read com.anthropic.claudecode` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json`, JSON files in `managed-settings.d`, and `HKLM` plus `HKCU` under `SOFTWARE\Policies\ClaudeCode`, value `Settings` |

Managed policy is read the same way as any other settings source: bare tool denials apply, and what has no native form is skipped and named in the run's notice. A managed source that cannot be read is named there too.

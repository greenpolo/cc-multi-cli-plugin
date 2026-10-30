# Permissions

Claude Code's permission mode reaches every provider. Select it before the prompt or worker starts.

## One permission control

Claude Code's permission mode is the single control at prompt boundaries. Direct
models retain Claude's permission checks; native harnesses translate supported
modes and reject unsupported ones. Auto does not imply a reviewer exists. Zen, Antigravity and Grok have none:
actions run unreviewed, and the status line says "no auto mode: actions run
unreviewed". Cursor reviews its own native actions and fails open when its
classifier is unavailable.
Plan restricts work to provider-supported plan capabilities. Bypass disables
automatic review where supported while retaining explicit capability restrictions.
Claude ask rules remain part of Claude's own tool permission checks.

The mode snapshot applies at the next prompt. Direct Claude, OpenAI, and Zen
workers record prompt identity and resolve tool permissions in Claude's loop.
Cursor, Antigravity and Grok load the full settings-policy snapshot at their prompts,
or lazily when a direct-model conversation requests a harness worker. Worker modes inherit or resolve from the parent
context according to the worker definition, except that a parent in Plan keeps
every worker in Plan, including one spawned earlier and resumed later. OpenAI
automatic review reads `classifier_context.permission_mode` in each model request,
so the request itself determines Plan restrictions. A
missing or unsupported mode fails explicitly.

## Provider enforcement

| Provider or action | What enforces the permission |
| --- | --- |
| OpenAI direct models | Claude Code's Read, Grep, Glob, Bash, Edit, and Write tools run the tool loop. The originating OpenAI account reviews tool uses inline before the reply completes. Read-only tools on the core skip list need no review. Reviewer failure or timeout refuses the action; discovery failure at launch leaves Auto unreviewed, with that statement in the status line. |
| Zen direct models | Claude Code runs and authorizes the tools. Zen auto mode is unreviewed like bypass; plan mode refuses actions that need review. Zen has no independent reviewer and never uses the OpenAI reviewer. |
| Cursor native harness | Native review belongs to the originating Cursor account and run. Cursor receives the prompt-boundary mode and capability restrictions. See [docs/cursor.md](cursor.md). |
| Antigravity native harness | A namespaced global pre-tool hook enforces Claude's denials while the native CLI runs. See [docs/antigravity.md](antigravity.md). |
| Grok native harness | Each run carries Claude's mode, a bounded native toolset and deny rules that outrank every mode; the announced toolset is checked against the policy. See [docs/grok.md](grok.md). |
| Claude tools | Claude's native permission checks and Anthropic classification apply. |

Claude `PreToolUse` and `PermissionRequest` hooks govern Claude-executed tools,
not each action inside a native harness. Provider SDK/CLI events supply native
action observations, which the gateway writes as display rows under the native tool
names (see [claude-mods.md](claude-mods.md)). A display row grants nothing: the
`mcp__multi-core` entry in a harness worker's tools only admits those rows, the
permission mappers drop it, and the mod refuses any call the gateway did not issue.
Native harness admission and provider policy enforce the actions without replaying
them as executable Claude tools. The launcher currently disables whole-session agent-view
handoff because its gateway and generated worker settings belong to the launcher;
ordinary background subagent tasks remain supported.

Start Cursor, Antigravity and Grok workers with the Agent tool. Workflow-started
native workers are unsupported because that engine path does not emit
`agent.spawn`, and `SubagentStart` alone lacks the parent and model needed to
admit inherited permissions safely. OpenAI and Zen workers use Claude's tool
loop and do not require this native harness admission. See [issue #32](https://github.com/greenpolo/cc-multi-cli-plugin/issues/32).

The launcher enables Claude's on-demand tool discovery through the local
gateway. Direct adapters omit deferred schemas until their names appear in a
tool reference, previous tool use, or an explicit named choice, and translate
tool references into provider-compatible context.

## Gateway verdicts

For every gateway-served reply requested with `safeguards`, core supplies an
`evaluated` verdict for every tool use before the final stream events, including
display rows, handbacks and empty failure replies. It never sends `unavailable`
or `skipped`, which would send a served tool call to Claude's local classifier.
OpenAI investigations run at most four at a time per reply and four across the
process. The 60-second budget per tool includes queue time. An explicit read-only list (Read, Glob, Grep, LS, ToolSearch and
MCP resource readers) skips reviewer calls, including in Plan. Coordination and
UI tools (TodoWrite, SubagentHandback, EnterPlanMode, ExitPlanMode,
AskUserQuestion, Agent/Task, Skill and task bookkeeping/output tools) also pass
without review in every mode. Process cancellation, worktree and scheduling
tools remain actions requiring a verdict. Plan blocks file-edit tools before
review and asks the reviewer to permit only read-only actions.

Every provider's `SubagentHandback` is `not_flagged`, including OpenAI and Zen
workers. Completed harness rows also pass when the request mode is missing. The report
and any embedded instructions reach the parent without a separate handback
review. Native capability restrictions still govern the actions taken inside the
harness. Anthropic traffic, including Claude's own classifier requests, passes
through unchanged with one exception: successful `/v1/messages` replies have a
string `input.model` removed from Agent calls to Multi provider worker types. The
gateway records the selection for `agent.spawn` and preserves the tool id and
server verdict, so no `tool.call` input rewrite triggers a paid local classifier
for a named-model spawn. Non-provider calls, errors and other routes retain their
bytes. Multi does not parse private classifier prompts or review Claude's own
actions. These verdicts do not bypass Claude's explicit deny rules.

## Explicit failures

Cursor, Antigravity and Grok admission fails explicitly for unsupported modes, unknown workers, untranslatable policies, and unavailable permission context. Multi does not apply these harness checks to Claude, OpenAI, or Zen workers. If the OpenAI reviewer is unavailable at launch, Auto remains available and actions run unreviewed. Plan refuses actions without a reviewer. Once a reviewer is enabled, a failed or timed-out review, malformed evidence, or unavailable evidence produces a `flagged` verdict with a plain explanation. The gateway never substitutes Claude or the working model for the account reviewer.

## Without Anthropic credentials

The launcher keeps Auto available for external models even when Claude is signed
out. Gateway-served tools receive provider verdicts; Claude inference and any
Claude-only classifier request are refused locally with "Anthropic is not signed
in", without forwarding or borrowing another provider's credentials.

In the inspected Claude Code 2.1.306 behavior, a separate handoff classifier or
ordinary workflow gate can allow an unreviewed result when classification is
unavailable. Oversized workflow output schemas are an exception and can be
refused. Auto-answer classification for AskUserQuestion falls back to the
question dialog; sandbox-network classification fails closed. These checks sit
outside the gateway-served tool verdict contract, so a signed-out session can
still encounter a dialog or denial. Explicit rules and native harness policy
remain in force. Multi keeps this external Auto capability rather than disabling
it for the whole session; switch to a signed-in Claude account for Claude-only
features. This describes the supplied binary evidence, not a new live probe.

## Managed policy sources

Native dispatch re-reads the selected settings and managed policy sources. Managed settings use the following locations.

| Platform | Managed sources |
| --- | --- |
| Linux | `/etc/claude-code/managed-settings.json` and JSON files in `/etc/claude-code/managed-settings.d/` |
| WSL | The Linux source: `/etc/claude-code/managed-settings.json` and `/etc/claude-code/managed-settings.d/` |
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json`, JSON files in `managed-settings.d`, and `defaults read com.anthropic.claudecode` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json`, JSON files in `managed-settings.d`, and `HKLM` plus `HKCU` under `SOFTWARE\Policies\ClaudeCode`, value `Settings` |

Managed policies accept supported permissions, hooks, and sandbox settings. Unsupported controls, argument or path rules, ask rules, sandbox policy, and ignored policy files fail admission when the native provider cannot enforce them. The provider that will run the request supplies that judgement, so a Claude tool rule one harness maps natively is enforced rather than refused because another harness could not map it.

# Antigravity

Run the official `agy` CLI as a native coding worker inside Claude Code.

## Setup

Install the plugin as described in [docs/installation.md](installation.md). Sign
in with the official `agy` account flow, then connect it to Claude Code:

```text
/multi-antigravity:connect
```

The connection command installs the scoped global `PreToolUse` hook. From a
checkout, the equivalent setup is:

```sh
node plugins/multi-core/src/launcher.ts --antigravity-setup
MULTI_ANTIGRAVITY=1 node plugins/multi-core/src/launcher.ts
```

Every launch points the hook at the copy of the plugin that is running, and each native
run repairs it if another copy changed it, so updating or switching copies needs no
second setup. `--antigravity-models` lists the catalog. The gateway uses `agy` authentication
and does not read provider tokens or call Antigravity model endpoints.

## Models

The picker reads the models advertised by `agy`.

| Picker entry | Route |
| --- | --- |
| Advertised base family | `multi/antigravity/<base>` |
| Advertised `-low`, `-medium`, or `-high` variant | `multi/antigravity/<id>` |
| Unsuffixed advertised model | `multi/antigravity/<id>` |

Suffix variants group behind a base row when no independent base model exists.
An advertised `-xhigh` variant keeps its own row and always runs at that effort,
because Claude Code's `/effort` offers these rows only low, medium and high.
The default variant order is medium, high, then low. `/effort` accepts only an
advertised low, medium, or high variant. Unknown models and unavailable effort
variants fail explicitly.

Workers: the Agent tool's `Antigravity` type runs any row above, except
an id that only adds an effort suffix to another listed row (`<base>-high`
beside `<base>`) — that stays selectable through `/effort`, not through
`model`. Pass `model: <id>` (for example `model: gemini-4-argon`) to pick a
model, or omit `model` to run the newest Gemini generation, Pro before Flash
at the same version (for example `gemini-4-argon` when 4 is newest).
Effort is never part of the model name: the session's `/effort` applies, and
Antigravity picks its advertised low/medium/high variant from it.

### Context window

Gemini picker rows carry a `[1m]` tag on the model ID, so Claude sizes the
session to the million input tokens Gemini accepts; an `Antigravity`
worker resolved to one of these rows keeps the tag on its spawned model. The
tag is Claude-side display metadata: `agy` never sees it, both spellings select
the same native model, and `/effort` still offers only the advertised low,
medium, and high variants.

Other advertised models keep Claude's 200K default, because their window is smaller
or unestablished: GPT-OSS 120B accepts 131,072 tokens, and the Claude models served
here carry no 1M entitlement. `agy models` reports no capacity metadata, so the
eligible families are listed in `multi-antigravity/src/models.ts` rather than discovered. Set
`MULTI_DISABLE_1M_CONTEXT=1` to leave every row untagged.

Claude's window governs when the session compacts. It is separate from the native
`agy` conversation, which keeps its own state and its own limits.

## Execution and permissions

Claude's permission mode and tool rules take precedence. `agy` runs with native
permissions skipped. The namespaced global hook reads `MULTI_ANTIGRAVITY_DENY`
and `MULTI_ANTIGRAVITY_ALLOW`. Mapped tools follow Claude's rules: a denied `Bash`
denies `run_command`, and browser tools follow the `WebFetch` grant. Your `agy` setup
stays yours: its MCP servers, subagents, scheduling, messaging and other tools no
Claude tool maps to run in Auto and Bypass. An MCP call (`call_mcp_tool`) is matched
against Claude's MCP deny rules (`mcp__minecraft`, `mcp__minecraft__*`,
`mcp__minecraft__search`). Plan is an allowlist of read, search and web lookup tools,
so MCP, agents and anything `agy` adds later stay out of it; an explicit tool list (an
agent type's `tools`) admits only the mapped tools and `mcp__` entries it names. Write
tools can never target `agy`'s own config tree (`~/.gemini`), where the hook lives. Each finished tool step is a row under agy's own tool name (`view_file`,
`run_command`, ...) with its native parameters and `tool_info.output`, in the
`/model` Antigravity session or inside the Antigravity worker's transcript; the
names come from agy's `init` toolset. Rows are never replayed as executable Claude
tools. `agy` does not distinguish a failed tool step: a failing command such as
`cat /nonexistent/file` ends `DONE` with the error only in its output and no exit
code, so the row shows as done and its output carries the error; Multi does not
guess failure from the text. The transcript keeps streamed text, run diagnostics,
and one closing summary of action counts, changed files, and failed steps; timing and
billing are shown by receipts, not written into the text. Claude and OpenAI parents can spawn Antigravity
workers.

Every run selects its native workspace explicitly with `--add-dir`; subprocess
cwd alone does not select it. Every Claude mode except Plan uses the native CLI,
while the hook enforces explicit Claude restrictions. Plan
also passes `--mode plan`, which only steers agy's model: with permissions
skipped it still runs shell and write tools. The hook therefore allows only
native read, search, and web lookup tools in Plan and denies every other tool,
including ones newer agy releases add. Compaction turns allow no tools. Any
other Claude mode runs as Bypass, and Claude rules with no native form are skipped
with a one-line notice; see [permissions](permissions.md).

The hook command uses a POSIX shell guard on Linux, macOS, and other Unix hosts.
Windows invokes Node directly because a shell is not assumed. Native config does
not grant permission to a run.

## Continuation, caching and failures

State is isolated by Claude session, worker, provider, and canonical workspace.
The gateway persists the native conversation ID and sends only the newest turn
after the last assistant message. Outer history changes produce a notice and
continue on the native conversation; native state is never rewound.

Completed identical requests can replay saved output. CLI usage is cumulative,
so resumed usage is differenced from the previous recorded total. Cache reuse is
best-effort.

A turn's `result` usage is the sum of every model call agy made in that turn;
each call's own usage arrives earlier on its `agent_response` step. The Messages
response therefore reports the last call's input and cache reads in its standard
fields, which Claude Code reads as the worker's live context, and the turn sums as
`multi_usage.consumed_*` with `model_calls`, which receipts and `/multi-usage`
charge as spend. The resume difference applies only to the sums; the last call is
already that call's own count. Gemini on Antigravity reports no prompt caching,
so its consumed input looks large next to Claude or Codex workers. An uncertain run is never replayed. If a run reports a conversation
ID but no terminal result, the next request streams an interruption notice before
continuing. Non-success terminal results are reported as errors and are retried
by a later identical request.

One turn runs at a time per worker and workspace. A different prompt sent while
a turn is running waits for it and then runs. A resent copy of the running request
(Claude Code retrying after a dropped connection) reattaches to the running turn
instead of starting the same native actions again.

## Config and hook paths per OS

| OS | Global hook file | Settings file |
| --- | --- | --- |
| Linux, macOS and Windows | `~/.gemini/config/hooks.json` | `~/.gemini/antigravity-cli/settings.json` |

On Windows `~` is `%USERPROFILE%`. Earlier releases wrote the hook under
`%LOCALAPPDATA%\gemini`, which `agy` does not read, so on Windows no Claude rule
reached `agy`; `multi uninstall` removes that stale entry too.

The installed hook is named `multi-cli-antigravity`. Setup preserves other hook
entries. Every launch with Antigravity enabled rewrites the entry, so it follows a plugin
update; run setup again after moving the checkout or changing the Node install.
`multi uninstall` removes the entry.

## Limits

The CLI accepts text and native automatic tools. Images, documents, forced tool
choices, strict output schemas, and stop sequences are unsupported. Native
compaction is owned by `agy`; Claude compaction summaries run with all mapped
native tools denied and preserve native history. Native counters and local prompt
estimates are reported separately.


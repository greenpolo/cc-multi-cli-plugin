# Claude Mods integration

Claude Mods (Claude Code function hooks) are Multi's only in-engine UI and
extension mechanism. The gateway supplies authenticated, bounded data through
`/multi/mod/*`; function hooks own Claude Code events and rendering. Provider
harnesses do not create terminal UI and the gateway does not emulate one.

## Official architecture and sources

The authoritative starting point is Anthropic's [Mods proposal and September 9
update](https://github.com/anthropics/claude-code/issues/91870). Anthropic calls
the product feature **Claude Mods** and the implementation primitive **function
hooks**: a Mod is a plugin whose behavior is implemented with function hooks.
Mods are generally available and on by default as of Claude Code 2.1.287; no
environment variable turns them on for a person. The engine's own declarations
(`.claude-plugin/types/claude-code/index.d.ts`, written beside a mod it loads from a
folder) are the API authority for this repository.

The issue's [Function Hooks: Core Architecture
PDF](https://github.com/user-attachments/files/31802150/EXTERNAL.Function.Hooks.Core.Architecture.pdf)
(Alice Poteat, Anthropic, August 2026) defines the model:

- `hooks/hooks.json` names a TypeScript/JavaScript hooks module. Its exported
  `register(on, options)` declares hooks before any hook runs.
- A hook is Koa-style middleware, `($, event, next)`. Registration order is
  nesting: earlier plugins wrap later plugins. A hook can run before, after, or
  during `next`, replace the result, or forward a copied/modified immutable
  event. Preserve `next(event)` unless Multi intentionally owns the result.
- `$` is the immutable engine capability interface. Side effects are explicit
  `$.noun.event(...)` calls, each itself hookable. `next.signal`, `next.event`,
  `next.origin`, and `next.is(...)` describe the current dispatch.
- `ui.render` receives a public component, serializable props, and a surface.
  `$.ui.resolve(event)` supplies that surface's native elements. Interaction
  handlers dispatch hookable `ui.press`-family events.
- Matchers are partial structural matches and narrow event types. `*` observes
  every event. A hook is skipped during its own recursive dispatch.
- Administrators obtain control from ordering and capability restriction, not
  from a bypass channel. An outer plugin can wrap events or withhold nouns while
  preserving the same composition model.

Anthropic's [built-in Mods source
listings](https://github.com/anthropics/claude-code/tree/main/mods) are the best
executable reference. The published README describes a hooks module as one
`register(on, options)` entry, typed against the declarations the engine writes, with
tests run by `claude plugin test`. As of the source tree
inspected September 22, 2026 (latest `mods/` commit `7974a707` dated September
20), it contains `diff`, `sec-default`, `telemetry`, and `agents-md`:

- [`diff`](https://github.com/anthropics/claude-code/tree/main/mods/diff) is the
  primary official UI example: a command-driven pane refreshed from edit and
  command activity.
- [`sec-default`](https://github.com/anthropics/claude-code/tree/main/mods/sec-default)
  demonstrates outermost managed policy and capability control.
- [`telemetry`](https://github.com/anthropics/claude-code/tree/main/mods/telemetry)
  demonstrates adding a typed noun to `$` in `engine.create` and controlling who
  can use it.
- [`agents-md`](https://github.com/anthropics/claude-code/tree/main/mods/agents-md)
  demonstrates instruction loading through engine hooks rather than prompt or
  filesystem side channels.

The issue's September 9 cheat-sheet image covers v267/v268-era affordances; treat
it as dated version evidence, not a permanent API promise. Multi's registration code
records that Claude Code 2.1.272 loads exactly one `hooks.json` module, so all Multi
hook registrars are composed by `hooks/register.ts`. The engine rewrites
`.claude-plugin/types/` each time it loads the mod from this checkout (and
`/plugin-types` writes the same declarations to a directory you name); test the
repository's supported Claude Code build when an event or result shape changes.

### Static rules the engine enforces

`claude plugin validate .claude-plugin/plugin.json` reads the hooks source the way the
engine will and refuses a module that breaks these rules, which shape the code:

- `$` is passed only into functions declared in the same file, never across an import.
  Each hooks file therefore builds its own small `wire($)` (four closures: the two
  `$.env.get` names, `$.http.fetch`, `$.clock.sleep`) and hands that to the shared
  gateway client in `gateway.ts`; cross-file helpers (`syncDisplayTools`, the policy
  client) take such closures, never `$`.
- `$.env.get` takes a literal name, and `$.noun.event(...)` is spelled at every call
  site; `$.env` and the like are never passed as values.
- A module hooks each event once without a matcher, so one `tool.call` hook (in
  `register.ts`) answers display rows and attributes every other call.
- State values are named where they are read: each file declares its own
  `atom({ plugin: 'multi-core', key: ... } as const, initial)` for the keys it uses; the
  value types come from `types/multi-core.d.ts`.
- A hooks module has no timers. Every wait is `$.clock` (`sleep`, `after`, `every`),
  which is also the only wait that counts against a hook's 10 s own-time budget; time
  inside any other `$` call (a gateway fetch) does not count.

## Community field report

The motivating community field report is [anthropics/claude-code issue 91870,
comment 5666255143](https://github.com/anthropics/claude-code/issues/91870#issuecomment-5666255143),
posted September 14, 2026 by a community author, not Anthropic. It points to
[`sezaakgun/cc-arcade`](https://github.com/sezaakgun/cc-arcade) as a working
function-hook UI and reports these primitives and constraints:

- `ui.render` can render an `AbovePrompt` surface, with interactive state in a
  `Client` surface module.
- `turn.complete` and `tool.call` let a Mod react to Claude lifecycle and tool
  activity without spending model tokens.
- `$.store` persists Mod-owned state between sessions; `$.state` holds session state
  that survives a hot reload and redraws any drawing that read it (Multi uses `$.state`).
- A `Client` module path must be a string literal so the engine can discover it.
- A JSX surface module must not bind a local variable named `h`, because JSX is
  compiled into calls to that identifier.
- The AbovePrompt band is roughly half the terminal. The referenced example
  redraws most animated surfaces at about 10 Hz (one at 20 Hz), so layouts and
  animation must tolerate a constrained surface and frame budget.

The linked project's [README, especially **How it works**, **Limits**, and
**Develop**](https://github.com/sezaakgun/cc-arcade#develop), is the practical
upstream reference behind those findings. It was written before general
availability, so validate behavior against the Claude Code version supported by this repository
instead of treating the example as a stable public specification.

## API map used by Multi

| Concern | Function-hook API used here | Multi behavior |
| --- | --- | --- |
| Startup and registration | `session.start`, `$.command.register`, `$.state`, `$.tool.register` | Registers `/multi-usage` and greets the gateway with the session (which also tells the launcher the Mod is live). The first prompt after a `/clear`, which fires no `session.start`, greets again. Multi registers no model-callable tools, and no display tool at start (see below). |
| Model and permission boundary | `classic.SessionStart`, `classic.UserPromptSubmit`, `$.session.model/cwd/id`, `$.state` | Records the effective Claude permission snapshot at prompt boundaries; it does not redesign provider permissions. A harness prompt always admits its settings policy; any other model's snapshot is posted only when the mode, workspace or model changed, and always kept in `$.state` so a harness worker spawned later admits against it. |
| Workers | `tool.call` (Agent), `tool.describe` (Agent), `agent.offer`, `agent.spawn`, `classic.SubagentStart`, `$.ui.invalidate('tool.describe')`, `ui.render` (ToolUse, UserMessage) | Takes the Agent tool's `model` out before Claude's Agent schema check, resolves it against the provider worker catalog at spawn (labelling the task's description, which the running-agents list and its notification show), admits harness children against the current policy generation, and labels the Agent row with the resolved provider and model, read from `$.state` so a resolved spawn redraws it. The Agent description names provider models only while a provider worker type is offered. An agent type skips gateway registration only when it is natively Claude: a built-in on a Claude session is classified locally, any other type by the gateway's offer (its model must not be a Multi model, so a definition pinned to `multi/openai/...` keeps registration), and `classic.SubagentStart` keeps the record while any loop of the session runs a Multi model. |
| Native action rows | `$.tool.register`, `turn.step`, `tool.describe`, `tool.check`, `tool.call`, `ui.render` for `ToolUse` and `ToolResult` | Registers a display tool per native tool name the gateway offers, lazily: at a harness prompt, before a harness worker spawns, and before a harness step when the catalog changed. A session that never runs a harness lists none. It defers them behind ToolSearch, allows only calls carrying a gateway-issued token, answers those with the native output from `POST /multi/mod/display`, and draws each row as Claude Code draws the built-in the native tool mirrors (Read, Bash, Grep, Glob, LS, Edit, Write), under the native tool's name. `ToolGroup` folding stays the engine's. |
| Usage UI | `command.run`, `$.ui.open` (`isPlaced`), `$.ui.toast`, `$.state`, `ui.render` for `Pane`, `ui.message` | Opens the interactive usage pane, renders its literal `Client` module from `$.state` (a write redraws it; nothing invalidates), and handles bounded refresh/receipt/toggle messages. A pane that waits undrawn is announced with a toast and its numbers are returned as text. |
| Lifecycle | `turn.step`, `turn.complete`, `session.end`, `$.clock.every`, `$.ui.status` | Records each loop's model, sends telemetry for a Multi step only, polls a harness run's status on a `$.clock` timer cancelled at `turn.complete` and `session.end`, completes/cancels runs, and forgets session-scoped state when the session ends (exit, `/clear` and resume alike). `session.detach` fires when any client leaves the roster, a session still running, so it is not hooked. |
| Reviewer attribution | `tool.call` | A provider loop's tool call (its `agentId` names the worker) is attributed to the gateway's reviewer with the session's snapshot mode; a Claude loop's call costs the gateway nothing. `classic.PreToolUse` carries neither the agent id nor a mode. |
| Compaction | `session.compact` | Keeps native-harness compaction provider-owned and generation-bound. |
| Local control plane | `$.http.fetch`, `$.env.get`, `$.clock.sleep` | `gateway.ts` calls authenticated loopback `/multi/mod/*` routes with an explicit method, a body bounded in bytes, and a `$.clock` deadline (1.5 s, 8.5 s for usage). Policy readiness is one request the gateway holds until discovery ends (bounded at 8 s), so no hook loops. |
| Hook state | `$.state` (`atom`, `read`, `update`), `types/multi-core.d.ts` | The policy snapshot, loop and spawn models, offer classification, display tools and usage panes live in `$.state`, declared by the `types` file `.claude-plugin/plugin.json` names, so a hot reload keeps them and a drawing that reads one is redrawn when it changes. Only per-call memos (the Agent model between `tool.call` and `agent.spawn`, a row's input between draws) and timers stay in module memory. |

The `classic.*` events are compatibility bridges for Claude Code's classic hook
payloads. New UI and extensibility still belongs in Mods; classic events do not
authorize an alternate renderer or permission path.

## Multi's contract

The implementation is deliberately split:

| Layer | Responsibility |
| --- | --- |
| `plugins/multi-core/hooks/*.ts` | Register function hooks, react to Claude events, open surfaces, and exchange UI messages. `gateway.ts` is the one gateway client, `state.ts` the bounded-record helpers, `policy.ts` the prompt-boundary admission. |
| `plugins/multi-core/types/multi-core.d.ts` | The `$.state` values the hooks keep (`PluginState`), named by `.claude-plugin/plugin.json` `types`. |
| `plugins/multi-core/hooks/*-view.ts` | Render `Client` surfaces (the usage pane); module paths at call sites stay literal. |
| `plugins/multi-core/hooks/rows.ts` | Register, gate, answer and draw the display rows of native harness actions. |
| `plugins/multi-core/hooks/rows-view.ts` | Draw a display row as the Claude Code built-in it mirrors. |
| `plugins/multi-core/hooks/worker-rows.ts` | Labels the Agent row and task notifications with `<provider> · <model>`. |
| `plugins/multi-core/src/gateway/mod-*.ts`, `display-rows.ts`, `worker-catalog.ts` | Authenticate and bound Mod routes for policy, model/worker state, lifecycle, display rows, compaction, usage, and receipts; resolve the Agent tool's `model` against each provider's worker catalog. |
| Provider adapters | Supply provider execution, state, authentication, and usage readers; never introduce a competing Claude Code UI channel. |

Current usage UI follows the upstream shape: `command.run` opens a Pane,
`ui.render` returns a `Client` with the literal module path
`./usage-view.ts`, and `ui.message` handles client actions.

Claude Code reads a response's `input_tokens` plus its cache read and write counts
as the live context window (`apiUsage`, the status line's fill, auto-compaction).
A harness turn (Cursor, Antigravity, Grok) runs many model calls, so its standard
usage fields carry the turn's last call when the harness reports per-call usage
(Antigravity and Grok; Cursor reports only run sums). What the turn consumed stays
on `multi_usage`: `consumed_input_tokens`, `consumed_output_tokens`,
`consumed_cache_read_tokens`, `consumed_cache_creation_tokens`, `reasoning_tokens`,
`total_tokens`, and `model_calls`. The follow-up message that answers a reply's
display rows repeats that context with zero output, because it is the turn's last
response. The receipts ledger charges the `consumed_*` fields when present and the
standard fields otherwise, and records the last response's context per receipt and
per provider, so the pane shows context, consumption, and cache reads side by side.

### Native action rows (design note)

**Why rows.** Cursor, Antigravity, and Grok run their own tools. In Claude Code a
row inside a session's or subagent's view exists only for a tool_use block in that
transcript; `ToolProgress` carries only the background-hint pill, and an
`AbovePrompt` band draws a worker's actions in the parent session instead of the
worker's. So each finished native action becomes a tool_use block in the
harness's own reply, and the row anchors where the action ran: the `/model`
harness session, or the Agent-tool worker's transcript (ctrl+o).

**Exact native tools.** A row is named after the harness's real tool, as the
harness reports it: Cursor's SDK tool-call type (`shell`, `read`, `edit`, `grep`,
...; `CURSOR_TOOLS`), the toolset `agy` announces in its `init` event
(`view_file`, `run_command`, ...; `ANTIGRAVITY_TOOLS`, captured in
`test/unit/fixtures/antigravity`), and Grok's announced toolset (`read_file`,
`run_terminal_command`, ...; `GROK_TOOLS`). `$.tool.register` lists each as
`mcp__multi-core__<name>`; that is engine naming, not an MCP server. The gateway
offers the static sets of the harnesses it runs (`GET /multi/mod/display-tools`),
adds any name a harness announces at run time, and bounds them (160 names,
`[A-Za-z0-9_-]`, 47 characters). The mod registers them lazily, so a
pure Claude session lists none (ToolSearch could otherwise surface them): at a harness
prompt, before a harness worker spawns, and before a harness `turn.step` when the
catalog changed (a registration takes effect from the next prompt, so the prompt hook
is what lets the first harness run's rows anchor). It then acknowledges the registered
set per session (`POST /multi/mod/display-tools`); the gateway emits rows only for names
the requesting session acknowledged, so a session without the mod gets the closing
summary alone. A session's end clears what it registered, and the next session
registers and acknowledges again.
Each harness worker definition lists `mcp__multi-core` in its tools, because the
engine dispatches a subagent's tool_use only for a tool its definition admits; the
Cursor, Antigravity, and Grok permission mappers drop that entry, so it grants no
native capability.

**Real arguments and output.** The input mirrors the Claude Code built-in the
native tool is equivalent to: `kind` names the built-in, its fields carry that
built-in's names (`file_path`, `command`, `pattern`, `path`, `glob`,
`old_string`/`new_string`, `content`), the native parameters stay whole under
`native` (strings cut at 2,000 characters, 32 keys; a written file or an edit's two
sides at 16 KiB), `failed: true` marks a failed action, and `multi_row` is a
128-bit token the gateway issues for that row, that session, and that tool_use id.
The mapping is `mirroredInput` in `display-rows.ts`, one table for every harness:

| Built-in (`kind`) | Cursor SDK | Antigravity (`agy`) | Grok | Mirrored fields |
| --- | --- | --- | --- | --- |
| Read | `read` (`path`) | `view_file` (`AbsolutePath`, `StartLine`, `EndLine`) | `read_file` | `file_path`, `offset`, `limit` |
| Bash | `shell` (`command`) | `run_command` (`CommandLine`) | `run_terminal_command`, `run_terminal_cmd` | `command`, `description` |
| Grep | `grep` (`pattern`, `path`, `glob`) | `grep_search` (`Query`, `SearchPath`, `Includes`) | `grep` | `pattern`, `path`, `glob` |
| Glob | `glob` (`globPattern`, `targetDirectory`) | `find_by_name` (`Pattern`, `SearchDirectory`) | none announced | `pattern`, `path` |
| LS | `ls` (`path`, `ignore`) | `list_dir` (`DirectoryPath`) | `list_dir` | `path` |
| Edit | `edit` (`path`; `old_string`/`new_string` are each hunk's sides from the result's `diffString`) | `replace_file_content`, `multi_replace_file_content` (`TargetFile`, `TargetContent`, `ReplacementContent`, chunks joined) | `search_replace` | `file_path`, `old_string`, `new_string` |
| Write | `write` (`path`, `fileText`); an `edit` whose `diffString` starts at `--- /dev/null` (`content` is its added lines) | `write_to_file` (`TargetFile`, `CodeContent`) | `write` | `file_path`, `content` |

Field names are matched case-insensitively among the listed native keys. Fields
a harness derives from a result (`DerivedMirror`, on the `NativeRow`) take
precedence, and may name another built-in: Cursor's `EditSuccess` (`linesAdded`,
`linesRemoved`, `diffString`) has no created flag, so a diff from `/dev/null` is a
Write row, and an edit reporting counts but no diff draws `Added N lines, removed M
lines` from those counts without a preview. Captured from real runs: the
`view_file` and `run_command` shapes (`test/unit/fixtures/antigravity`), and
Cursor's `read`, `grep`, `glob`, `shell` and `edit` args and `edit` results
(`test/unit/fixtures/cursor`; Composer 2.5 created a file through `edit` and listed
through `shell`, so `write` and `ls`, both in the SDK's tool-call union, are
uncaptured); the rest follow the SDK's types or the harness's documented schema. A tool with no equivalent (a browser action, `mcp`,
`task`) carries `native` alone. The output (16 KiB) stays in the gateway: the
mod's `tool.call` fetches it with the token and returns it as the row's result, or
as an error result for a failed action.

**Drawing.** The engine draws a registered tool as `multi-core - view_file
(MCP)(AbsolutePath: "/w/a")`; rewriting `ToolUse`'s `tool` to `Read` changes only
the label (the arguments keep the MCP form), and a `ToolResult` rewritten to Read's
result record draws nothing, since the output is checked against the MCP tool's
schema. So `rows-view.ts` draws the header and the summary results itself, after
the built-ins as captured from the terminal (`tmux capture-pane -e`, Claude Code
2.1.280): `●` in the theme's `success` (`error` for a failed or refused action),
the bold name, the argument in parentheses in the text colour (paths relative to
the session's directory, Read's ` · lines 1-5`, Grep's `pattern: "x", path:
"src"`), then `  ⎿ ` and a no-break space in `inactive` with the result beside it:
`Read 5 lines`, `Found 3 files` or `Found 2 lines`, `Listed 4 paths`, `Wrote 10
lines to new.txt` with a numbered preview, `Added 1 line, removed 1 line` with a
numbered diff on the `diffAdded`/`diffRemoved` backgrounds, and a failure as
`Error: ...` in `error`, counts in bold. A Bash row's output, and any tool without a
built-in, is delegated to the engine with the output rewritten to its cleaned text,
so it keeps the engine's own compact form (three lines and `… +N lines`) and its
full ctrl+o form. Only the name differs from a Claude row: the native tool's
(`view_file`), where Claude shows `Read`.

Known differences: the header does not switch to absolute paths under ctrl+o and
paths are not hyperlinks (a `ToolUse` hook is told neither the view nor offered a
`file:` link); drawn previews stop at 10 lines (40 for a diff) with `… +N lines`
and no ctrl+o hint, because the hook cannot tell the compact view from the
expanded one; the diff uses the theme's diff colours, not the structured diff's
syntax palette; and the engine folds only its own tools into `ToolGroup` count
lines (`Read 1 file, ran 1 shell command`). A `ToolGroup` hook can set only
`isExpanded`, so a mirrored row stands alone in the compact view where Claude's
would be folded, and is counted in no parent's line.

**No fake tools for any model.** The gateway removes every display tool from each
forwarded `tools` list, every display tool_use and its tool_result from each
forwarded history (closing up the turns), and the display names from Claude Code's
ToolSearch catalogue, ToolSearch `tool_reference` results and worker tool lists, for
every provider, Anthropic included.
`tool.describe` returns `isDeferred: true`, so no prompt lists them. `tool.check`
allows a call only when `POST /multi/mod/display` confirms its token for that
session and tool_use id, and `tool.call` refuses the rest, so a model-originated call
is denied with a reason that says so. OpenAI and Zen workers run Claude's own tools
and are untouched.

**The turn's last message.** The engine runs a reply's rows and then asks for the
turn's next message, and a worker's parent receives the worker's last message. So
once a reply has written a row, the rest of its text (the answer, the closing
summary) is held as `multi_followup`, and the gateway answers that next request,
whose last turn holds only the rows' results, with it, without a native run. The
harness's record of its reply includes that text, so the next turn's history still
matches. The held text is bound to the session, worker and provider whose reply
wrote the rows, and only that scope's request naming that reply's rows receives it;
any other is refused, and a session's held texts are dropped when it ends.
After a restart or an eviction the gateway reads it back from the harness's session
record (`recordedResponse`); when no record holds it, the request fails explicitly.
An action whose completion never arrives is settled when the run ends as
unconfirmed: its row's dot is `inactive` with an `Unconfirmed:` result, and the
closing summary counts it without listing it under `Changed:`.

**Status and failures.** `turn.step` polls `GET /multi/mod/lifecycle` for the
status line (model, scope, state, elapsed time, current action). A failed run or a
request refused before dispatch (policy admission, unavailable provider, invalid
request) records one sanitised 240-character reason, which the status line and the
refused request's error both carry.

**Replaced.** The six `mcp__multi-core__cursor_*` rows and
`MULTI_CURSOR_DISPLAY_TOOLS` (generic names, output in the input, rows in the
main session only), and the `AbovePrompt` progress band with its
`/multi/mod/progress` route. Cursor records holding the old blocks still replay.

Other hooks retain
permission snapshots, model and worker selection, progress/lifecycle,
compaction, session cleanup, and quota advice through the same authenticated
Mods control plane.

The gateway token is in the environment of every Bash command, so a token alone does
not admit a session's `/multi/mod/*` POSTs. The gateway mints a per-session key on the
first POST it sees for a `sessionId` and returns it in an `x-multi-mod-key` response
header. `gateway.ts` captures it from any reply, keeps it by session id in the host-held
`$.state` value `multi-core.modKeys` (so a hot reload keeps it; a key held only in module
memory would lock the Mod out, since the gateway never re-issues one after the first echo),
and sends it as `x-multi-mod-key` on every later request that names that session. After the
first echo the gateway refuses token-only POSTs for that session with 403. The key is
never put in the environment, a log, or a Client surface payload; other plugins could read
the state value, but they already run in the engine with the same environment. `session.end`
sends `/multi/mod/detach` with the key, then forgets it.

The gateway bounds what the Mod can make it hold: a session's snapshot and policy
tables evict the least recently used idle session instead of refusing a new one, an
unconsumed policy job is reused for a minute at most, and a policy request may carry
`wait: true` to be held until discovery ends.

## Testing the hooks

`npm run test:mod` type-checks the hooks and their tests against the engine's own
declarations (`.claude-plugin/types/`, written when the mod loads from this checkout;
`/plugin-types` writes the same files elsewhere) and runs `claude plugin test` with the
installed Claude executable, without provider inference. Mods are on by default in
Claude Code 2.1.287, but `claude plugin test` follows the server rollout flag, which is
served off for some accounts; the script therefore sets
`CLAUDE_INTERNAL_FC_OVERRIDES={"tengu_plugin_hooks_modules":true}` for that process
only (no `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is involved). A test that reaches the
gateway client installs `mock.clock(on)`, because each request is bounded by
`$.clock`; a test of a timer advances that clock.

## Rules for changes

Any Claude Code harness UI or extensibility change must use function-hook Mods,
as requested by the maintainer. Reuse the existing `/multi/mod/*` control plane
when gateway data or actions are needed; purely local rendering needs no route.
Do not add an alternate terminal renderer, synthetic executable Claude tools, prompt-driven
UI, or a provider-specific UI side channel. Display rows are not executable tools:
they run nothing, only the gateway can originate one, and no model is offered one. Keep provider credentials and raw
provider state out of Mod payloads. Routes must remain authenticated, bounded,
session/worker scoped, and read-only where the action is observational.

When adding a surface:

1. Register the event in `plugins/multi-core/hooks/`. If it needs gateway data,
   use the authenticated local gateway client.
2. Put interactive rendering in a surface module and pass its `Client.module`
   as a literal string.
3. Avoid a local `h` binding in JSX surface modules.
4. Preserve `next(event)` behavior for events the Mod does not own.
5. Bound retained state (keep it in `$.state`, not module memory), payload size,
   refresh rate, and gateway latency (wait on `$.clock`, never a timer).
6. Add hook tests and gateway route tests for session isolation, stale state,
   authentication, and failure fallback.

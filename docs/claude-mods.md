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
The update says the interface was still early access and rapidly iterating, but
that core semantics had settled enough to publish built-in source.

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
`register(on, options)` entry, typing against declarations written by
`/plugin-types`, and tests run with `claude plugin test`. As of the source tree
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

The issue's September 9 cheat-sheet image covers v267/v268-era affordances and
documents the opt-in command
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude`. Treat it as dated version evidence,
not a permanent API promise. Multi's registration code records that Claude Code
2.1.272 loads exactly one `hooks.json` module, so all Multi hook registrars are
composed by `hooks/register.ts`. Regenerate current local declarations with
`/plugin-types` and test the repository's supported Claude Code build when an
event or result shape changes.

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
- `$.store` persists Mod-owned state.
- A `Client` module path must be a string literal so the engine can discover it.
- A JSX surface module must not bind a local variable named `h`, because JSX is
  compiled into calls to that identifier.
- The AbovePrompt band is roughly half the terminal. The referenced example
  redraws most animated surfaces at about 10 Hz (one at 20 Hz), so layouts and
  animation must tolerate a constrained surface and frame budget.

The linked project's [README, especially **How it works**, **Limits**, and
**Develop**](https://github.com/sezaakgun/cc-arcade#develop), is the practical
upstream reference behind those findings. Function hooks are early access, so
validate behavior against the Claude Code version supported by this repository
instead of treating the example as a stable public specification.

## API map used by Multi

| Concern | Function-hook API used here | Multi behavior |
| --- | --- | --- |
| Startup and registration | `session.start`, `$.command.register`, `$.tool.register` | Registers `/multi-usage`, display-only Cursor rows, and the initial authenticated Mod session. |
| Model and permission boundary | `classic.SessionStart`, `classic.UserPromptSubmit`, `$.session.model/cwd/id` | Records the effective Claude permission snapshot at prompt boundaries; it does not redesign provider permissions. |
| Workers | `agent.offer`, `agent.spawn`, `classic.SubagentStart` | Maps named worker selection and admits harness children against the current policy generation. |
| Display rows | `tool.call`, `tool.check`, `ui.render` for `ToolUse`/`ToolResult` | Treats native Cursor actions as allowed, display-only observations; never replays them as provider execution. |
| Usage UI | `command.run`, `$.ui.open`, `$.ui.invalidate`, `ui.render` for `Pane`, `ui.message` | Opens the interactive usage pane, renders its literal `Client` module, and handles bounded refresh/receipt/toggle messages. |
| Lifecycle/progress | `turn.step`, `turn.complete`, `session.detach` | Updates telemetry and receipts, completes/cancels runs, and forgets session-scoped state. |
| Compaction | `session.compact` | Keeps native-harness compaction provider-owned and generation-bound. |
| Local control plane | `$.http.fetch`, `$.env.get` | Calls authenticated loopback `/multi/mod/*` routes with bounded bodies and timeouts. |

The `classic.*` events are compatibility bridges for Claude Code's classic hook
payloads. New UI and extensibility still belongs in Mods; classic events do not
authorize an alternate renderer or permission path.

## Multi's contract

The implementation is deliberately split:

| Layer | Responsibility |
| --- | --- |
| `plugins/multi-core/hooks/*.ts` | Register function hooks, react to Claude events, open/invalidate surfaces, and exchange UI messages. |
| `plugins/multi-core/hooks/*-view.ts` | Render interactive `Client` surfaces; module paths at call sites stay literal. |
| `plugins/multi-core/src/gateway/mod-*.ts` | Authenticate and bound Mod routes for policy, model/worker state, lifecycle, progress, compaction, usage, and receipts. |
| Provider adapters | Supply provider execution, state, authentication, and usage readers; never introduce a competing Claude Code UI channel. |

Current usage UI follows the upstream shape: `command.run` opens a Pane,
`ui.render` returns a `Client` with the literal module path
`./usage-view.ts`, and `ui.message` handles client actions. Other hooks retain
permission snapshots, model and worker selection, progress/lifecycle,
compaction, session cleanup, and quota advice through the same authenticated
Mods control plane.

## Rules for changes

Any Claude Code harness UI or extensibility change must use function-hook Mods,
as requested by the maintainer. Reuse the existing `/multi/mod/*` control plane
when gateway data or actions are needed; purely local rendering needs no route.
Do not add an alternate terminal renderer, synthetic executable Claude tools, prompt-driven
UI, or a provider-specific UI side channel. Keep provider credentials and raw
provider state out of Mod payloads. Routes must remain authenticated, bounded,
session/worker scoped, and read-only where the action is observational.

When adding a surface:

1. Register the event in `plugins/multi-core/hooks/`. If it needs gateway data,
   use the authenticated local gateway client.
2. Put interactive rendering in a surface module and pass its `Client.module`
   as a literal string.
3. Avoid a local `h` binding in JSX surface modules.
4. Preserve `next(event)` behavior for events the Mod does not own.
5. Bound retained state, payload size, refresh rate, and gateway latency.
6. Add hook tests and gateway route tests for session isolation, stale state,
   authentication, and failure fallback.

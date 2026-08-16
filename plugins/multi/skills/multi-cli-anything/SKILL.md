---
name: multi-cli-anything
description: Add a new CLI provider to cc-multi-cli-plugin (beyond the built-in Codex/Cursor/Antigravity/OpenCode). Use when the user asks to integrate another AI CLI like Aider, Qwen, or any CLI that can be driven headlessly (a `-p`/print mode with JSON output, an app-server/HTTP mode, or any structured transport). Trigger phrases include "add Aider to the plugin", "integrate Qwen", "hook up my custom CLI", "support another model via its CLI".
---

# Add a new CLI to cc-multi-cli-plugin

cc-multi-cli-plugin is a **multi-plugin marketplace** with four built-in CLIs: Codex, Cursor, Antigravity, and OpenCode. Adding a new CLI beyond these means two things:

1. **A new adapter** in the `multi` hub — `plugins/multi/scripts/lib/adapters/<cli>.mjs` — that conforms to the adapter contract and is registered in `lib/adapters/registry.mjs`, plus a dispatch branch in `lib/commands/task.mjs`.
2. **A new thin plugin** — `plugins/<cli>/` with command files + a `plugin.json`, registered in the root `marketplace.json` — that forwards `/<cli>:<role>` into the hub via `multi:<cli>-<role>` subagents.

**The adapter interface is transport-agnostic.** The companion consumes only the five-method `adapter` object defined in `plugins/multi/scripts/lib/adapters/CONTRACT.md` (`name`, `isAvailable`, `isAuthenticated`, `invoke`, `cancel`, plus optional `getSession`). *How* the adapter talks to the CLI — headless print mode, spawn-and-read-files, app-server HTTP, or (legacy) ACP — is your choice, driven by what the CLI actually exposes. **Read `CONTRACT.md` first**; it's the source of truth for the result shape.

There is **no `buildPrompt()` function** and no slash-command-prefix layer (an older design that's gone). A role's read/write behavior is expressed as CLI flags/sandbox inside the adapter; a role's prompt framing lives in its subagent `.md`. Don't reintroduce a `buildPrompt`.

## Step 0 — Research the CLI first

Before writing any code, pull everything you need so you don't guess or ask the user later:

- **Install status and binary name** — is the user's machine set up? What's the exact command (`agent`? `qwen`? `aider`? `opencode`?).
- **A drivable headless transport** — see Prerequisites below. This is the make-or-break question.
- **Exact model identifiers** the CLI accepts (or `auto` if offered). A wrong model string causes a 400/exit-1 at runtime.
- **Modes / permission flags** — read-only vs write, an `ask`/`plan` mode, a `--force`/`--yolo` auto-approve flag, a sandbox setting. These are what you'll map roles onto inside the adapter.
- **Runtime flags** — output format (`--output-format json`?), resume/session, background — what does `--help` actually list?
- **Authentication mechanism** — env var, OAuth keyring, device code, API key header.
- **Known quirks** (Windows shell requirements, PATH issues, empty-stdout-when-piped bugs, version-specific behavior).

**Pick sources proportional to the question.** Start cheap and authoritative; escalate only if unclear.

### First: search for an existing Claude Code (or other) integration of this CLI

Before anything else, **search exa for an existing implementation**. The community has wired up many CLIs already — finding one collapses days of trial-and-error into "read their adapter, adapt to our marketplace structure."

Useful queries (try in order, stop when you find a working example):

```
<cli-name> claude code plugin
<cli-name> headless print mode json output
<cli-name> agent SDK / programmatic API
<cli-name> claude-code marketplace
<cli-name> @anthropic-ai claude
```

A reference implementation reveals things probes don't:

- **Spawn quirks** — does the CLI need `shell: true` on Windows? A specific env var to init? Does it want the prompt on stdin vs as an arg?
- **Output completeness** — does its `-p` mode actually print the answer, or (like `agy`) write nothing to stdout when piped? What's the JSON envelope shape?
- **Auth flow specifics** — env vars, token paths, OAuth dance details.
- **Model ID conventions** — version suffixes, deprecated aliases. (The Gemini family's `-preview` suffix trap — which Antigravity surfaces — is the canonical example.)

If you find one:
1. Read its full implementation. Note any "this CLI is weird about X" comments.
2. Note pre-flight config it requires (env, config-file entries, auth setup).
3. Cite the source (NOTICE attribution + a comment in the new adapter).
4. Adapt — don't blindly copy. Our marketplace structure differs; the principles transfer, the file paths don't.

If you don't find one (or it's stale), proceed with the verification ladder below. Looking is cheap.

### Verification sources, in order of cost/authority

1. **`<cli> --help`, `<cli> models`, `<cli> about`, `<cli> --list-models`** — fastest, no network, authoritative for "what does this binary accept right now."
2. **Vendor docs via context7** — `resolve-library-id` → `query-docs`. Good for canonical names and deprecation context.
3. **exa web search** — for changelogs, forum posts, obscure flags context7 doesn't have.
4. **CLI source on GitHub** — config constants. Slowest; use only when 1–3 disagree or come up empty.
5. **Prompt the CLI itself** (`<cli> -p "List the exact model strings this CLI accepts."`) — only when no listing subcommand exists and docs are empty. Costs credits.

**Hard rules:**
- **Never ask one CLI about another CLI's features.** A CLI is a source only for itself.
- **Preview-suffix trap:** many CLIs qualify unstable IDs with `-preview`/`-beta`/`-exp`. Don't hardcode the unsuffixed variant — it 404s at runtime.
- **Resolving disagreements:** CLI wins for "does it work right now"; docs win for "should I use this."
- **Record the source you used** inline so the user can catch a bad citation.
- **Read the existing adapters** in `plugins/multi/scripts/lib/adapters/` — they're your worked examples (see the transport table at the end).

Proceed without asking the user to confirm facts you can verify yourself.

## Prerequisites — confirm the CLI can be driven headlessly

Check in this order. The first match that fits the CLI is your transport; the earlier ones are simpler.

### 1. Headless print mode with structured output (the common path)

Most modern agent CLIs have a non-interactive mode: `-p`/`--print` with `--output-format json` (single result object) or `--output-format stream-json` (NDJSON events + a final result). The prompt goes in as an arg or on stdin. **This is how Cursor is driven by default** (`agent -p`; it also has an opt-in ACP path — see path 4), and it's the path most new CLIs will use. If `<cli> --help` shows a print/headless mode with JSON output, **go to "Headless integration"** below — `cursor.mjs` is your template.

### 2. The CLI runs headlessly but writes nothing usable to stdout

Some CLIs run a prompt but don't print the answer to stdout when piped (a known class of bug — e.g. Antigravity's `agy`, google-antigravity/antigravity-cli#318). If the CLI persists results somewhere on disk (a transcript/log/session file), you can still drive it: spawn it, learn the artifact location, and read the answer back. **This is how Antigravity is driven** — `antigravity.mjs` is your template. More work than path 1, but the same five-method `adapter` interface.

### 3. App-server / HTTP transport (ASP)

Some CLIs expose a long-lived server (HTTP + SSE, JSON-RPC over a socket) you connect to and stream turns from. **This is how Codex is driven** (`codex --app-server` behind a broker daemon) — `codex.mjs` + `lib/app-server.mjs` are your template. Reuse this only if the CLI genuinely requires it.

### 4. ACP (Agent Client Protocol) — live, opt-in

ACP is a cross-vendor stdio JSON-RPC standard (newline-delimited JSON-RPC 2.0). The plugin has a **maintained, SDK-based ACP client** at `lib/acp/client.mjs` (built on the official `@agentclientprotocol/sdk`), and **Cursor and OpenCode both ship ACP adapters** behind the `MULTI_TRANSPORT_CURSOR` / `MULTI_TRANSPORT_OPENCODE` env flags (default `headless`, opt-in `acp`). ACP buys in-protocol model selection (`session/set_config_option`), session modes for read-only (`session/set_mode` → `ask`/`plan`), and a real `session/cancel`. Take this path when a CLI's ACP mode is genuinely better than its headless mode, OR when you want those structured controls. See "ACP integration" at the end — `lib/acp/client.mjs` + `lib/acp/resolve.mjs` and the dual-transport pattern in `cursor.mjs`/`opencode.mjs` are your templates. (Note: an older hand-rolled `lib/acp-client.mjs` still exists but is legacy/slated for deletion — do NOT build on it; use `lib/acp/client.mjs`.)

### None of the above?

If the CLI has no headless/print mode, no on-disk result artifact, and no server/ACP mode, it can't be driven non-interactively yet. Suggest the user file a feature request upstream for a `-p`/JSON mode.

## The adapter interface (read CONTRACT.md)

Every adapter exports one `adapter` object. The companion consumes only this:

```js
export const adapter = {
  name: "<cli>",          // MUST equal the registry key
  isAvailable,            // sync  (cwd) => { available, detail, version? }   — never throws
  isAuthenticated,        // async (cwd) => { authenticated, ... }
  invoke,                 // async (cwd, prompt, options) => result           — see below
  cancel,                 // async (jobId) => { attempted, interrupted, transport, detail }
  getSession,             // function | undefined
};
```

`invoke`'s `result` carries, by convention: `text` (joined assistant output), `error` (`null` on success, else an object — **set it, don't throw**), `sessionId`/`threadId`, and optionally `fileChanges`, `commandExecutions`, `toolCalls`. `options` may include `model`, `role`, `effort`, `sessionId`, `write`, `onStream`/`onProgress`. Keep the shape uniform so the companion's render/dispatch code stays generic. The conformance test (`test/unit/adapter-contract.test.mjs`) enforces this — `npm test` fails until your adapter matches.

## Headless integration (the common path)

Worked example: `cursor.mjs`. Copy it and adapt.

### Step 1 — Pick a short CLI name

The CLI's brand name, lowercased: `qwen`, `aider` (opencode is already built in). This becomes the `--cli <name>` flag value, the registry key, and the slash-command namespace.

### Step 2 — Create the adapter inside `multi`

```bash
cp plugins/multi/scripts/lib/adapters/cursor.mjs plugins/multi/scripts/lib/adapters/<new-cli>.mjs
```

Edit the new file (these are the real pieces in `cursor.mjs`):

1. **Binary resolution** — adapt `findCursorBinary()` → `find<NewCli>Binary()`: an env override (`<NEWCLI>_CLI_PATH`), then `where`/`which`, then a sensible fallback. Keep the env override — it's the operator escape hatch.
2. **Role → flags** — adapt `isReadOnlyRole()` + the `READ_ONLY_ROLES` set and `buildHeadlessArgs()`. Map your roles to the CLI's real flags: a read-only/`ask` mode for research/explore-style roles, an auto-approve/write mode for delegate/implement-style roles. This is where "role behavior" lives (there is no `buildPrompt`).
3. **Output parsing** — adapt `parseJsonResult()` / `normalizeHeadlessOutcome()` / the `derive*` helpers to the CLI's JSON envelope. Match the result object's field names (Cursor uses `{type:"result", result, session_id, is_error}` — yours will differ). **Branch on exit code AND the parsed result**, never the result alone: startup errors (bad model, auth) print plain text to stderr with no JSON envelope.
4. **Availability / auth** — adapt `getCursorAvailability()` (a `--version` probe; never throws) and `getCursorAuthStatus()` (a `status`/login probe).
5. **The turn** — adapt `runHeadlessCursorTurn()`: spawn `<cli>` with `buildHeadlessArgs(...)`, deliver the prompt (Cursor uses **stdin** — newline-safe, avoids cmd.exe quoting; do the same unless the CLI requires an arg), collect/parse output, resolve the result shape. For stream-json, map events to progress via `onStream`.
6. **Cancel** — adapt `cancelHeadlessCursor()`. Headless jobs are cancelled by the companion's process-tree kill of the job pid; the adapter's `cancel` just reports the mechanism.
7. **The `adapter` export** — rename to the new CLI and wire your functions:
   ```js
   export const adapter = {
     name: "<new-cli>",
     isAvailable: get<NewCli>Availability,
     isAuthenticated: get<NewCli>AuthStatus,
     invoke: runHeadless<NewCli>Turn,
     cancel: cancelHeadless<NewCli>,
     getSession: undefined,
   };
   ```
8. Syntax-check: `node --check plugins/multi/scripts/lib/adapters/<new-cli>.mjs`.

### Step 3 — Register the adapter and add a dispatch branch

Three files, post-monolith-split. The `ADAPTERS` map lives in `registry.mjs` — the companion imports it from there via `getAdapter(name)`; **do NOT look for or add an inline `ADAPTERS` map inside `multi-cli-companion.mjs`**.

1. **`plugins/multi/scripts/lib/adapters/registry.mjs`** — import and register:
   ```js
   import * as <newCli> from "./<new-cli>.mjs";
   export const ADAPTERS = { codex, cursor, antigravity, opencode, <newCli> };
   ```
   This is the single source of truth the companion and the contract test both read. The contract test (`test/unit/adapter-contract.test.mjs`) checks every registered adapter — adding an adapter here means the test count will increase (one test per registered CLI); bump the expected count in the test if it hardcodes a number.

2. **`plugins/multi/scripts/lib/commands/task.mjs`** — `executeTaskRun(request)` dispatches per `cli`. Add an `if (cli === "<new-cli>") { ... }` branch mirroring the **cursor** branch (availability check → build prompt → `await <newCli>.adapter.invoke(workspaceRoot, prompt, { model, role, write, onStream })` → render via `renderTaskResult` → return the standard payload). Add your CLI's label to `buildTaskRunMetadata()`'s `cliLabel` map so jobs get a CLI-specific title. If your CLI can't loop resume turns, mirror the antigravity guard in `handleTask` (`if (untilDone && cli === "<new-cli>") throw …`).

3. **`plugins/multi/scripts/multi-cli-companion.mjs`** — add the name to the `--cli <codex|cursor|antigravity|opencode>` usage string in `printUsage()` (cosmetic but expected). The dispatcher itself needs no other change — it resolves the adapter via `getAdapter(cliName)` from the registry.

Syntax-check both scripts and run `npm test` — the contract test will tell you if the adapter shape is off.

### Step 4 — Verify the integration empirically

The CLI's `--help` contract doesn't always match what its headless mode actually does. Before declaring done, run a real prompt that exercises what the user will rely on (file writes, MCP, web/codebase reads) and read the output:

```bash
node plugins/multi/scripts/multi-cli-companion.mjs task \
  --cli <new-cli> --role <write-role> --write \
  "Write a file hello.txt containing 'hi', then read it back." 2>&1
```

Check, in whatever order is relevant for what the user wants this CLI to do:

- **Result parses.** Does your `normalizeHeadlessOutcome` find the answer? A run that returns empty `text` with a non-zero exit is almost always a startup error sitting in stderr (`2>&1` shows it) — bad model id, not signed in, sandbox block.
- **Read vs write modes.** Run a read-only role and confirm it *can't* write; run the write role and confirm it *can*. This validates your `READ_ONLY_ROLES`/`buildHeadlessArgs` mapping.
- **Model pass-through.** Pass a bad `--model` and confirm the CLI's error (often exit 1 + an "Available models: …" list) surfaces through `2>&1`. Then pass a good one. Don't hardcode a model list in the adapter — it drifts; let the CLI validate.
- **MCP wiring.** If the user needs MCP tools, confirm they fire. Many CLIs read MCP servers from their **own config file** (Cursor: `~/.cursor/mcp.json`; Codex: `~/.codex/config.toml`; Antigravity/agy: `~/.gemini/settings.json`), not from anything we pass. If tools are "missing," populate that file.
- **Cancel.** Start a long background run (`--background`) and `/multi:cancel <job-id>`; confirm the process tree dies.

For a clean headless CLI most of this just works. Don't add guards for problems the CLI doesn't have.

### Step 5 — Add subagents (forwarders) for each role

One file per role: `plugins/multi/agents/<new-cli>-<role>.md`. Match the shape of the shipped forwarders — they are NOT bare one-liners:

````markdown
---
name: <new-cli>-<role>
description: <disjoint, role-specific trigger — when to use THIS role, and when not to (point at sibling roles).>
model: sonnet          # see model-by-role below
tools: Bash
skills:
  - multi-cli-runtime  # REQUIRED — the shared flag/failure contract
---

You are a thin forwarding wrapper around the cc-multi-cli-plugin companion runtime for <NewCli>'s <role> role.

Forward the user's request to the companion via exactly one Bash call. Do not do the work yourself.
The forwarding contract — flag handling, `--plan`/`--prompt-file`, `2>&1`, the failure line — is in the `multi-cli-runtime` skill. Follow it exactly.

## Prompt framing            ← include ONLY for write/agentic roles; omit for pure read bridges
**Skip this section entirely if `--plan`/`--prompt-file` is present** (the file is the prompt).
Otherwise prepend this block, then a blank line, then the user's task verbatim:
```
You are <NewCli> in agent mode. Implement the task end-to-end without asking for confirmation.
End with a structured report: ## Outcome / ## Files touched / ## Verification / ## Notes.
Task:
<user task verbatim>
```

## Companion invocation
Use exactly one Bash call:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" task --cli <new-cli> --role <role> ... 2>&1`
- Default `--write` for write roles; pass `--read-only` for read-only roles.
- Return the companion's stdout verbatim. On Bash failure or empty output, return one line: `<NewCli> <role> failed: <one-line reason>`.
````

**Model by role** (this mirrors the shipped forwarders and the official `codex-plugin-cc`):
- **Sonnet** for forwarders that *frame or route* the prompt — write/agentic roles (implement, delegate) and anything choosing model/effort. Better framing materially improves what the external CLI then produces.
- **Haiku** for pure path-bridges that do *no* framing — a read-only research/review forwarder that just passes flags through. Cheapest correct model.

Use `multi-plan-handoff` (already shipped) on the parent side for execute/delegate roles — no per-CLI work needed; just reference it from the command file (Step 7).

### Step 6 — Create the new plugin directory

```bash
mkdir -p plugins/<new-cli>/.claude-plugin plugins/<new-cli>/commands
```

Write `plugins/<new-cli>/.claude-plugin/plugin.json` (match the **current** marketplace version — check `marketplace.json`; the shipped plugins are at `3.0.0`):

```json
{
  "name": "<new-cli>",
  "description": "Delegate <roles> to <NewCli> CLI (headless). Part of cc-multi-cli-plugin. Requires the `multi` plugin.",
  "version": "3.0.0",
  "author": { "name": "greenpolo", "url": "https://github.com/greenpolo" },
  "license": "Apache-2.0",
  "keywords": ["claude-code", "<new-cli>", "<role>"]
}
```

### Step 7 — Write command files

One markdown per role in `plugins/<new-cli>/commands/<role>.md` (filename becomes the part after the colon — `write.md` → `/<new-cli>:write`):

```markdown
---
description: <what this does>
argument-hint: "[--background|--wait] [--model <model>] <what to do>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `multi:<new-cli>-<role>` subagent via the `Agent` tool, forwarding the user's request.

Raw user request:
$ARGUMENTS

Return the subagent's output verbatim.
```

For an execute/delegate (write) role, add a short "plan-by-reference" note like `cursor/commands/delegate.md` has, pointing at the `multi-plan-handoff` skill, so a plan file in context is passed with `--plan <path>` instead of paraphrased.

### Step 8 — Register the new plugin in the marketplace

Edit `.claude-plugin/marketplace.json` (repo root) and add to the `plugins` array:

```json
{
  "name": "<new-cli>",
  "description": "Adds /<new-cli>:<roles>. Requires multi.",
  "version": "3.0.0",
  "author": { "name": "greenpolo" },
  "source": "./plugins/<new-cli>"
}
```

### Step 9 — Install and test

```bash
claude plugin validate <repo-root>        # must pass — catches JSON/frontmatter errors
npm test                                   # contract + offline suite, no tokens
claude plugin marketplace update cc-multi-cli-plugin
claude plugin install <new-cli>@cc-multi-cli-plugin
claude plugin install multi@cc-multi-cli-plugin --force   # pick up new subagent files
```

Restart Claude Code (subagent definitions are session-cached), then try `/<new-cli>:<role> <prompt>`. Add a `CHANGELOG.md` entry under `## Unreleased`.

## Spawn + read-artifacts integration (no usable stdout)

Worked example: `antigravity.mjs`. Take this path only when the CLI runs headlessly but doesn't print the answer (path 2 in Prerequisites). The structure differs from the headless-JSON path in one place — `invoke` instead of parsing stdout:

1. Spawn the CLI with whatever makes it persist results (for `agy`: `agy -p "<prompt>" --add-dir <cwd> --log-file <tmp> --print-timeout`).
2. Learn the result location. `agy` writes a `Created conversation <id>` line to the `--log-file`; the adapter parses it (with a `cache/last_conversations.json[cwd]` fallback) and reads `~/.gemini/antigravity-cli/brain/<id>/.../transcript.jsonl` — the last non-empty `PLANNER_RESPONSE`/`MODEL` step is the answer.
3. Watchdog: kill the process tree on timeout; clean up the temp log.
4. Conform to the same five-method `adapter` interface; `isAvailable` is a `--version`/path probe, `isAuthenticated` checks the CLI's own credential file.

Steps 3 (register + dispatch), 5–9 (subagents, plugin, commands, marketplace, install) are **identical** to the headless path. The lesson `antigravity.mjs` teaches: the `adapter` interface is transport-agnostic — when a CLI has no clean stdout to parse, you implement the same five methods over "spawn the binary and read the files it writes."

## ASP integration (HTTP/app-server)

Worked example: `codex.mjs` (split into `codex-transport.mjs` / `codex-render-parse.mjs` / `codex-roles-prompts.mjs`) + `lib/app-server.mjs` + the broker daemon (`app-server-broker.mjs`, `lib/broker-lifecycle.mjs`). Take this only if the CLI requires a long-lived server connection. It's substantially more code (session/broker lifecycle, idle reaping). Steps 3, 5–9 still apply — registration, dispatch, and plugin scaffolding are transport-agnostic. Model the new adapter on `codex.mjs` instead of `cursor.mjs`.

## ACP integration (live transport)

The plugin has a maintained ACP client at **`lib/acp/client.mjs`** (the `runAcpTurn(spec)` runner, built on the official `@agentclientprotocol/sdk`) plus **`lib/acp/resolve.mjs`** (win32-first binary resolution). Cursor and OpenCode both run over it when `MULTI_TRANSPORT_CURSOR` / `MULTI_TRANSPORT_OPENCODE` is `acp`. The dual-transport pattern in `cursor.mjs` / `opencode.mjs` — an adapter that picks ACP vs headless per turn from an env flag and maps both to the same result shape — is your template for adding ACP to a new CLI. (An older hand-rolled `lib/acp-client.mjs` / `acp-diagnostics.mjs` predates this and is legacy/slated for deletion — do NOT build on it; `lib/acp/client.mjs` is the live one.)

Reach for ACP when a CLI's ACP mode is clearly better than its headless mode, or when you want the structured controls it gives (in-protocol model select, session modes, real cancel). To wire it: have your adapter call `runAcpTurn({ exe, args, cwd, prompt, sessionMode, model, resolveModel, allowWrites, onStream, ... })` from `lib/acp/client.mjs`, gated behind a `MULTI_TRANSPORT_<CLI>` flag, with a `resolve<Cli>Acp()` helper in the spirit of `lib/acp/resolve.mjs`.

Set `ACP_TRACE=1` and watch stderr for the JSON-RPC traffic while running a real prompt. Things that bite ACP integrations specifically — each is handled in the shipped client, but verify per CLI:

- **Permission gate.** `runAcpTurn` auto-rejects `session/request_permission` by default (read-only) and allows only with `allowWrites`. Some agents gate tool use out-of-band instead (a config file / pre-approval list) and never send the request — e.g. OpenCode enforces read-only via an injected `OPENCODE_PERMISSION` deny floor, not ACP permissions.
- **Read-only.** Capability-withholding is NOT sufficient (verified: agents still write via internal tools). Use the agent's own mode/permission mechanism — `session/set_mode` → `ask`/`plan` (Cursor) or a deny-config env (OpenCode).
- **Model selection.** `session/set_config_option` with `{sessionId, configId:"model", value}`, validated against the live `configOptions` from `session/new` (no silent fallback). Cursor needs exact composite ids (`composer-2.5[fast=true]`) — that's what the `resolveModel` callback is for.
- **Cancel.** `session/cancel` is honored by some CLIs (Cursor) and ignored by others (OpenCode mislabels a cancelled turn as `end_turn`), so `runAcpTurn` treats "cancel requested + turn ended" as cancelled regardless, and tree-kills after a grace window.
- **Watchdogs.** The inactivity watchdog covers the handshake too (a CLI that spawns and hangs silently is caught by `inactivityMs`, not the 30-min overall cap). `MULTI_ACP_INACTIVITY_MS` / `MULTI_ACP_OVERALL_MS` override the windows.
- **win32 spawn.** Resolve the real executable, never an npm `.cmd`/`.exe` shim (see `lib/acp/resolve.mjs`: OpenCode's platform exe, Cursor's bundled `node.exe` + `index.js acp`).
- **MCP wiring.** `runAcpTurn` passes `mcpServers: []` in `session/new`, so the CLI reads its own MCP config file (this is also what Cursor expects in ACP mode) — `/multi:setup` maintains that file.

## Worked examples by transport

The shipped adapters cover the live transport shapes — match the one that fits the CLI you're adding:

| Transport | Worked example | When |
|---|---|---|
| **Headless print mode** (prompt on stdin/arg, JSON or stream-json on stdout) | `cursor.mjs`, `opencode.mjs` | The common path. Any CLI with a `-p`/`--print` + `--output-format json` mode. Aider, etc. |
| **Headless NDJSON** (prompt on stdin, NDJSON event stream on stdout) | `opencode.mjs` | OpenCode's `opencode run --format json` — a NDJSON variant of headless print mode; same five-method interface. |
| **Spawn + read-artifacts** (CLI runs but stdout is empty/unusable; answer persisted on disk) | `antigravity.mjs` | A CLI with an empty-piped-stdout bug or a transcript/log file as the only result sink. |
| **ASP / app-server** (HTTP+SSE or socket JSON-RPC to a long-lived server) | `codex.mjs` + `lib/app-server.mjs` | A CLI that only exposes a server mode. |
| **ACP** (stdio JSON-RPC, official SDK) | `lib/acp/client.mjs` + `lib/acp/resolve.mjs`; dual-transport adapters `cursor.mjs` / `opencode.mjs` | When a CLI's ACP mode beats headless, or you want in-protocol model select / session modes / `session/cancel`. Opt-in per CLI via `MULTI_TRANSPORT_<CLI>=acp`. |

## Things NOT to change when adding a new CLI

- `plugins/multi/scripts/lib/job-control.mjs`, `state.mjs`, `render.mjs`, `workspace.mjs`, `tracked-jobs.mjs` — shared infrastructure.
- The existing adapters (`codex*.mjs`, `cursor.mjs`, `antigravity.mjs`, `opencode.mjs`) — read them as templates; don't modify them.
- `plugins/multi/scripts/multi-cli-companion.mjs` beyond the one-line `--cli` usage string — it's a thin dispatcher.
- `plugins/multi/hooks/hooks.json` — unless the new CLI specifically needs a hook.

You DO edit, by design: your new `<cli>.mjs`, `registry.mjs`, `lib/commands/task.mjs` (dispatch branch + label), and the new `plugins/<cli>/` plugin.

## Closing

After adding a new CLI, consider contributing the adapter back upstream — the modular adapter interface exists precisely so new CLIs are easy to land. A working adapter + a contract-test pass + a CHANGELOG note is the bar.

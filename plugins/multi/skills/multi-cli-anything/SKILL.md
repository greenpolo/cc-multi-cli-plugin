---
name: multi-cli-anything
description: Add a new CLI provider to cc-multi-cli-plugin (beyond the built-in Codex/Cursor/Antigravity). Use when the user asks to integrate another AI CLI like OpenCode, Aider, Qwen, or any CLI that speaks ACP, ASP, ConnectRPC, or another structured protocol. Trigger phrases include "add OpenCode to the plugin", "integrate Aider", "hook up my custom CLI", "support another model via ACP".
---

# Add a new CLI to cc-multi-cli-plugin

cc-multi-cli-plugin is a **multi-plugin marketplace**. Adding a new CLI means adding a new plugin to the marketplace plus wiring a new adapter into the shared companion runtime in the `multi` plugin.

## Step 0 — Research the CLI first

Before writing any code, pull everything you need to know about the CLI so you don't have to guess or ask the user later. Extract:

- **Install status and binary name** — is the user's machine set up? What's the exact command (`cursor-agent`? `agent`? `qwen`? `aider`?)
- **Structured transport** — does it support ACP, ASP, or structured stdout? (See prerequisites below.)
- **Exact model identifiers** the CLI accepts (or `auto` if offered). Hardcoding a wrong model string causes 400 errors at runtime.
- **Available slash commands and modes** — e.g., `/research`, `/review`, `/plan`, `/debug`, `/ask`, or whatever the CLI exposes. These determine which roles you'll map to slash-command prefixes in `buildPrompt()`.
- **Runtime flags** — sandbox, read-only, effort, background, resume — what does the CLI's `--help` actually use?
- **Authentication mechanism** — env var, OAuth, device code, API key header, etc.
- **Known quirks** (Windows shell requirements, PATH issues, version-specific behavior).

**Pick sources proportional to the question.** Do NOT run every source for every fact. Start cheap and authoritative; escalate only if unclear.

### First: search for an existing Claude Code integration of this CLI

Before doing anything else, **search exa for an existing implementation**. The community has wired up many CLIs already (Cursor's ACP adapter, various OpenCode/Aider ports, etc.) — finding one collapses days of trial-and-error into "read their adapter, adapt to our marketplace structure."

Useful queries (try in this order, stop when you find a working example):

```
<cli-name> claude code plugin
<cli-name> ACP adapter
<cli-name> claude-code marketplace
<cli-name> agent client protocol
<cli-name> @anthropic-ai claude
```

A reference implementation reveals things probes don't:

- **Spawn quirks** — does the CLI need `shell: true` on Windows? A specific env var to init?
- **ACP protocol completeness** — many "ACP-supporting" CLIs implement the protocol incompletely; an existing adapter shows what edge cases break.
- **Auth flow specifics** — env vars, token paths, OAuth dance details.
- **Model ID conventions** — version suffixes, deprecated aliases. (The Gemini model family's `-preview` suffix trap — which Antigravity surfaces — is the canonical example.)
- **Schema-validation pitfalls** — does the CLI's config reject unknown keys? Strict-mode JSON?

If you find one:
1. Read its full adapter implementation. Note any "this CLI is weird about X" comments.
2. Note any pre-handshake config it requires (extra params in the `initialize` call, custom auth methods, etc.).
3. Cite the source in your file (NOTICE attribution, plus a comment in the new adapter).
4. Adapt — don't blindly copy. Our marketplace structure differs from theirs; the principles transfer, the file paths don't.

If you don't find one (or it's stale / not maintained), proceed with the verification ladder below. Looking is cheap; not looking is how you spend 4 hours debugging an ACP handshake that needed one specific param.

### Verification sources, in order of cost/authority

1. **`<cli> --help`, `<cli> models`, `<cli> about`** — fastest, no network, authoritative for "what does this binary accept right now."
2. **Prompt the CLI itself** (when no listing subcommand exists):
   ```bash
   <cli> -p "List the exact <thing> strings this CLI accepts. One per line."
   ```
3. **Vendor docs via context7** — `resolve-library-id` → `query-docs`. Good for canonical names and deprecation context.
4. **exa web search** — for changelogs, forum posts, obscure flags context7 doesn't have.
5. **CLI source on GitHub** — `config/models.ts` constants. Slowest; use only when 1–4 disagree or come up empty.

For a yes/no question ("does this CLI have ACP?") use source 1 or 3 and stop. For a canonical ID that gets hardcoded into files, use 1 plus 3 or 4 to cross-check — two sources is enough.

**Hard rules:**
- **Never ask one CLI about another CLI's features.** It hallucinates as badly as you would. A CLI is a source only for itself.
- **Preview-suffix trap:** Many CLIs qualify unstable IDs with a suffix (`-preview`, `-beta`, `-exp`). Don't hardcode the unsuffixed variant — it will 404 at runtime. Gemini-family IDs (served via Antigravity) have historically all ended in `-preview`.
- **Resolving disagreements:** CLI wins for "does it work right now"; docs win for "should I use this."
- **Record the source you used** inline in your response so the user can catch a bad citation.
- **Check existing adapters** in `plugins/multi/scripts/lib/adapters/` as reference templates for the transport pattern you'll reuse.

Proceed without asking the user to confirm facts you can verify yourself.

## Prerequisites — confirm the CLI speaks a structured transport

Check in this order:

### 1. Does it support ACP (Agent Client Protocol)?

ACP is a cross-vendor standard. Check the CLI's `--help` output for:
- `--acp` flag (used by several Gemini/Copilot-style CLIs)
- `acp` subcommand (used by Cursor)
- An `--stdio` or `--server` mode that outputs NDJSON/JSON-RPC

If yes, this is the easy path. Skip to "ACP integration" below.

### 2. Does it support ASP (App Server Protocol)?

ASP is OpenAI's flavor — HTTP + SSE, as used by Codex (`codex --app-server`). If the CLI has a similar flag, you can reuse much of the Codex adapter pattern.

### 3. Does it have a structured headless output mode?

Some CLIs have `-p` or `--print` modes with `--output-format=json` or similar. Not as rich as ACP/ASP but workable — wrap subprocess invocation and parse the JSON stream.

### 4. None of the above?

The CLI is probably not a good fit yet. Suggest filing a feature request upstream for ACP support.

## ACP integration (easiest path)

### Step 1 — Pick a short CLI name

Use the CLI's brand name, lowercased. E.g., `qwen`, `opencode`, `aider`. This becomes the `--cli <name>` flag value and the slash-command namespace.

### Step 2 — Create the adapter inside `multi`

Copy the canonical Cursor adapter as a template:

```bash
cp plugins/multi/scripts/lib/adapters/cursor.mjs plugins/multi/scripts/lib/adapters/<new-cli>.mjs
```

Edit the new file:

1. **Rename functions** from `*Cursor` to `*<NewCli>` (e.g., `runAcpPromptCursor` → `runAcpPromptOpenCode`).
2. **Update `buildPrompt(role, userTask)`** — map role names to slash-command prefixes the CLI understands.
3. **Update the CLI binary name / args.** ACP subcommand: `args: ["acp"]`. ACP flag: `args: ["--acp"]` or `["--acp", "--stdio"]`.
4. **Update the `adapter` export:**
   ```js
   export const adapter = {
     name: "<new-cli>",
     isAvailable: get<NewCli>Availability,
     isAuthenticated: get<NewCli>AuthStatus,
     invoke: runAcpPrompt<NewCli>,
     cancel: interruptAcpPrompt<NewCli>,
     getSession: undefined,
   };
   ```
5. Syntax-check: `node --check plugins/multi/scripts/lib/adapters/<new-cli>.mjs`.

### Step 3 — Register the adapter in the companion

Edit `plugins/multi/scripts/multi-cli-companion.mjs`:

1. Add import near the other adapter imports:
   ```js
   import * as <newCli> from "./lib/adapters/<new-cli>.mjs";
   ```
2. Extend `ADAPTERS`:
   ```js
   const ADAPTERS = { codex, cursor, antigravity, <newCli> };
   ```
3. Extend `executeTaskRun`'s dispatch with an `else if (cli === "<new-cli>")` branch mirroring the cursor branch exactly, substituting `<newCli>.adapter.invoke(...)`.
4. Extend `buildTaskRunMetadata`'s label map so jobs get a CLI-specific title.
5. Syntax-check: `node --check plugins/multi/scripts/multi-cli-companion.mjs`.

### Step 3.5 — Verify ACP behavior empirically

ACP is a standard, but every CLI implements it slightly differently. The contract a CLI advertises in `--help` doesn't always match what its `acp` mode actually does. Before declaring the integration done, run a real prompt that exercises the tools the user will rely on (shell exec, file writes, MCP, web search) and watch the wire.

Set `ACP_TRACE=1` and check a real run end-to-end:

```bash
ACP_TRACE=1 node plugins/multi/scripts/multi-cli-companion.mjs task \
  --cli <new-cli> --role <role> --write \
  "Run \`echo hello\`, then write a file, then call an MCP tool."
```

Then look at stderr for incoming JSON-RPC traffic from the agent. The `[acp-trace] <- REQ <method>` lines tell you which client-side ACP methods the agent expects you to provide; `<- NOTIF session/update[<kind>]` lines show streaming progress.

Things to verify (don't have to be in order — just check whichever is relevant for what the user wants this CLI to do):

- **Permission gate.** Does the agent send `session/request_permission` over ACP, or does it gate tool use through some out-of-band mechanism (a config file, a flag, a pre-approval list)? If you see `tool_call_update` go to `in_progress` and never `completed` with no incoming REQs, it's almost always an out-of-band gate. (Cursor historically gated via `~/.cursor/cli-config.json`'s `permissions.allow` array — that workaround is no longer needed since the 2026.04.17 regression was fixed upstream, but the pattern recurs in other CLIs, so watch for it.)
- **Terminal handling.** Some agents implement `terminal/*` RPCs themselves (just declare `clientCapabilities.terminal=true` in the handshake and `acp-client.mjs`'s `buildAutoApproveRequestHandler` services them). Others run terminals internally and skip ACP entirely. Watching for `<- REQ terminal/create` tells you which.
- **MCP wiring.** `session/new` accepts an `mcpServers` array, but some agents silently ignore it in ACP mode (Cursor staff has confirmed this for `agent acp`). If the agent reports your MCP tools as missing, see if the CLI has a per-CLI MCP config file (e.g. `~/.cursor/mcp.json`) you should populate instead.
- **Mode setting.** `session/set_mode` semantics vary: for Cursor, "agent" gives full tool access while "plan"/"ask" restrict it; other ACP CLIs expose an equivalent (e.g. an `approvalMode: "yolo"`-style param) for max permissions. Try setting and not setting it during testing.
- **CLI-side flags.** A CLI's interactive `--yolo` / `--force` / `--approve-mcps` flags often **don't apply to ACP mode** — they're for the interactive REPL or `-p` print mode. Don't assume they're a fix; verify on the wire.
- **Version sensitivity.** The same CLI can change behavior across builds (e.g. Cursor 2026.04.14 → 2026.04.17 broke MCP tool use in ACP). If something works locally and breaks in the field, check version specifics.

**The Cursor adapter is the worked example for everything above.** When in doubt, read `plugins/multi/scripts/lib/adapters/cursor.mjs` end-to-end — it shows the full set of workarounds that actually shipped: handshake capability declaration, mode-setting per role, model selection via `session/set_config_option`, version-specific warnings, and spawn flags. Adapt the patterns that apply to the new CLI; not all of them will.

For straightforward CLIs (clean ACP impl, no out-of-band gates), most of the above will be no-ops and the basic adapter scaffold from Step 2 will just work. Don't add guards for problems the CLI doesn't have.

### Step 4 — Add subagents for each role

Create one subagent file per role in `plugins/multi/agents/<new-cli>-<role>.md`:

```markdown
---
name: <new-cli>-<role>
description: Use when the user asks for <role-appropriate tasks> via <NewCli>.
model: sonnet
tools: Bash
---

You are a thin forwarding wrapper around the cc-multi-cli-plugin companion runtime for <NewCli>.

Use exactly one `Bash` call:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" task --cli <new-cli> --role <role> ...`

Preserve task text verbatim. Return stdout exactly. No commentary.
```

Subagent names are `<cli>-<role>` (e.g., `opencode-writer`). Invocation path: `subagent_type: "multi:<cli>-<role>"`.

### Step 5 — Create the new plugin directory

```bash
mkdir -p plugins/<new-cli>/.claude-plugin plugins/<new-cli>/commands
```

Write `plugins/<new-cli>/.claude-plugin/plugin.json`:

```json
{
  "name": "<new-cli>",
  "description": "Delegate <roles> to <NewCli> CLI. Part of cc-multi-cli-plugin. Requires the `multi` plugin.",
  "version": "3.0.0",
  "author": { "name": "greenpolo", "url": "https://github.com/greenpolo" },
  "license": "Apache-2.0",
  "keywords": ["claude-code", "<new-cli>", "<role>", "acp"]
}
```

### Step 6 — Write command files

One markdown per role in `plugins/<new-cli>/commands/<role>.md`:

```markdown
---
description: <what this does>
argument-hint: "[--model <model>] <what to do>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Dispatch to the `multi:<new-cli>-<role>` subagent via the `Agent` tool.

Raw user request:
$ARGUMENTS

Return the subagent's output verbatim.
```

Command filename becomes the part after the colon in the slash: `plugins/opencode/commands/write.md` → `/opencode:write`.

### Step 7 — Register the new plugin in the marketplace

Edit `.claude-plugin/marketplace.json` (at the repo root) and add a new entry to the `plugins` array:

```json
{
  "name": "<new-cli>",
  "description": "Adds /<new-cli>:<roles>. Requires multi.",
  "version": "3.0.0",
  "author": { "name": "greenpolo" },
  "source": "./plugins/<new-cli>"
}
```

Validate: `claude plugin validate <repo-root>` should pass.

### Step 8 — Install and test

```bash
claude plugin marketplace update cc-multi-cli-plugin
claude plugin install <new-cli>@cc-multi-cli-plugin
claude plugin install multi@cc-multi-cli-plugin --force   # pick up new subagent files
```

Restart Claude Code. Try `/<new-cli>:<role> <prompt>`.

## ASP integration (medium difficulty)

ASP requires a different transport (HTTP + SSE vs stdio JSON-RPC). If the new CLI uses ASP-style servers:

1. Study `plugins/multi/scripts/lib/app-server.mjs` and `plugins/multi/scripts/lib/adapters/codex.mjs`.
2. Model the new adapter on `codex.mjs` instead of `cursor.mjs`.
3. Steps 3–8 above still apply — the `ADAPTERS` registration and plugin scaffolding are protocol-agnostic.

This is more code than ACP integration — only take this path if the new CLI genuinely requires it.

## Subprocess + stream-json integration (fallback)

If the CLI lacks ACP/ASP but has a headless JSON-output mode, write an adapter that:
1. Spawns the CLI with `-p --output-format=json` (or equivalent).
2. Parses the JSON stream or final output.
3. Normalizes to the same result shape as other adapters: `{ sessionId, text, fileChanges, error }`.

The `adapter` export interface (`name`, `isAvailable`, `invoke`, etc.) stays identical — only the transport differs.

## Worked examples by transport

The shipped adapters cover three transport shapes — use whichever matches the CLI you're adding:

- **ACP (stdio JSON-RPC)** — `cursor.mjs` is the canonical worked example. Any CLI exposing an `acp` subcommand or `--acp`/`--stdio` mode follows this pattern. OpenCode, Aider, and similar ACP-capable CLIs are candidates here.
- **ASP (HTTP + SSE)** — `codex.mjs` is the worked example (`codex --app-server`). Model on it when the CLI uses an app-server style transport.
- **Non-ACP headless CLI (spawn + read artifacts)** — `antigravity.mjs` is the worked example of a CLI that does **not** speak ACP or any structured stdio/HTTP protocol you can stream. Google's `agy` runs a prompt via `agy -p`, but (as of agy 1.0.3) writes nothing to stdout when piped (upstream bug gemini-cli#27466), so the adapter spawns it, learns the conversation id from a per-invocation `--log-file`, and recovers the answer from `agy`'s on-disk transcript JSONL. It conforms to the same `adapter` export interface (`name`, `isAvailable`, `isAuthenticated`, `invoke`, `cancel`). The lesson it teaches: **the `adapter` interface is transport-agnostic** — when a CLI has no clean protocol to drive headlessly, you can still register it by implementing the same five-method interface over whatever it does expose (here: spawn the binary and parse the files it writes), with detection (`isAvailable`) as a `--version`/path probe.

Any CLI that speaks a structured protocol — stdio, HTTP, or RPC-to-a-running-app — is a candidate.

## Things NOT to change when adding a new CLI

- `plugins/multi/scripts/lib/acp-client.mjs`, `job-control.mjs`, `state.mjs`, `render.mjs` — shared infrastructure.
- `plugins/multi/scripts/lib/adapters/codex.mjs`, `cursor.mjs`, `antigravity.mjs` — existing adapters.
- `plugins/multi/hooks/hooks.json` — unless the new CLI specifically needs a hook.

## Closing

After adding a new CLI, consider contributing the adapter back upstream. The plugin welcomes new CLIs that demonstrate working adapters — it's part of why the architecture is modular.

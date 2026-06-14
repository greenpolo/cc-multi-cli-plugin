---
name: customize
description: Rewire which CLI handles which role in cc-multi-cli-plugin, OR diagnose/work around an upstream CLI quirk via env vars and config files. Use when the user asks to swap CLIs, change a subagent's target CLI, add or disable a subagent or command, restrict a CLI to read-only, hardcode a model, or change how a role frames its prompt — and also when a CLI is misbehaving (hangs, missing tools, broken release) and the user needs operator escape hatches like CURSOR_AGENT_PATH or AGY_CLI_PATH or OPENCODE_CLI_PATH, or per-CLI MCP config tuning. Works for any CLI in the marketplace — the four default CLIs (Codex, Cursor, Antigravity, OpenCode) and any additional CLIs the user added via the multi-cli-anything skill. Trigger phrases include "swap Codex and Cursor", "make Antigravity the researcher", "disable cursor-explore", "restrict Codex to read-only", "change which CLI handles implementation", "add /<cli>:<command>", "only install the plugins I need", "hardcode a model for <some-role>", "change the framing for <role>", "cursor is hanging / broken / stuck", "pin an older cursor build".
---

# Customize cc-multi-cli-plugin

cc-multi-cli-plugin is a **multi-plugin marketplace**: one hub plugin (`multi`) plus one thin plugin per AI CLI the user has wired up. Customization is explicit file edits across those plugins. **There is no runtime config layer and no `buildPrompt()` function** — a CLI's behavior is assembled from a few small, separate files, and you edit the one that owns the thing you want to change.

**This skill is CLI-agnostic.** Every instruction below works for any CLI in the marketplace — the four shipped defaults (Codex, Cursor, Antigravity, OpenCode) and any CLIs added later via the `multi-cli-anything` skill (Aider, etc.). Concrete examples use specific CLI names for clarity; apply the same pattern to any CLI.

## The four moving parts every customization touches

A `/<cli>:<action>` invocation flows through four artifacts. Each owns one concern. A customization edits whichever one owns what you're changing — usually one or two.

| Artifact | Path | Owns | Edit it to… |
|---|---|---|---|
| **Slash command** | `plugins/<cli>/commands/<action>.md` | The user-facing entry point. Dispatches to the subagent via the `Agent` tool. | add/rename/disable a `/<cli>:<action>` command |
| **Subagent (forwarder)** | `plugins/multi/agents/<cli>-<role>.md` | The `multi:<cli>-<role>` forwarder. Loads the `multi-cli-runtime` skill, optionally **frames** the prompt, and builds exactly ONE companion `Bash` call. Its `model:` is tuned by role (see below). | change a role's prompt framing, its model, its tools, or which `--cli`/`--role` it forwards to |
| **Adapter** | `plugins/multi/scripts/lib/adapters/<cli>.mjs` | The CLI's transport, plus the **role→flag/sandbox** mapping (read-only vs write, mode flags). Registered in `registry.mjs`. | change how a role maps to the CLI's own flags/permissions |
| **Shared contract** | `plugins/multi/skills/multi-cli-runtime/SKILL.md` | The flag-handling, routing, and failure-line contract **every** forwarder obeys (`--model`, `--effort`, `--write`/`--read-only`, `--resume`, `--until-done`, `--plan`, `2>&1`, the `<CLI> <role> failed: …` line). | change behavior shared across all CLIs (rare — it affects everything) |

Two facts that the old `buildPrompt()` model got wrong and that you must internalize:

- **Prompt *shape* lives in the subagent `.md`, not the adapter.** Each write-role forwarder (e.g. `cursor-delegate.md`, `codex-execute.md`) contains a fenced **framing block** ("You are Cursor in agent mode…") that it prepends to the user's task. To change how a role frames its prompt, edit that block. Read-only forwarders (`codex-review`, `antigravity-researcher`) usually have little or no framing.
- **Role *behavior* (read vs write, CLI flags) lives in the adapter** — and is done differently per CLI. Codex switches on a sandbox (`read-only` vs `danger-full-access`) selected by the `--write` flag in `lib/commands/task.mjs`; Cursor maps roles to headless flags in `buildHeadlessArgs()` plus a `READ_ONLY_ROLES` set in `cursor.mjs`; Antigravity is always read-only; OpenCode maps roles in `buildHeadlessArgs()` plus `READ_ONLY_ROLES` in `opencode.mjs` (no `--read-only` flag — enforced via env injection). Verify the specific CLI's mechanism before editing (Step 2).

## Step 0 — Locate the plugin repo

Before editing anything, determine WHICH files to edit. Three scenarios:

1. **Check `claude plugin marketplace list`** — find the `installLocation` for `cc-multi-cli-plugin`.
2. **Classify the install:**
   - If `installLocation` is a local directory the user controls (dev clone, fork they own) — **edit those files directly.** Changes are live.
   - If `installLocation` is under `~/.claude/plugins/marketplaces/cc-multi-cli-plugin/` and sourced from a GitHub repo the user does NOT own — **edits there will be overwritten** on the next `claude plugin marketplace update`. STOP and tell the user they need to fork the repo, clone their fork, and re-register that clone as the marketplace source.
3. **Ask the user** if you can't tell which scenario applies.

Record the path you'll edit as `$REPO`. All subsequent file paths are relative to `$REPO`.

## Step 1 — Discover the current inventory (don't rely on memory)

Users may have added CLIs via `multi-cli-anything` that aren't in any documentation, and the shipped roster shifts between versions. Always run these before planning changes:

```bash
ls $REPO/plugins/                                       # CLI plugins installed
ls $REPO/plugins/multi/agents/                          # subagents (forwarders)
find $REPO/plugins -name "*.md" -path "*/commands/*"    # slash commands
ls $REPO/plugins/multi/scripts/lib/adapters/            # adapters
cat $REPO/plugins/multi/scripts/lib/adapters/registry.mjs   # which adapters are registered
cat $REPO/.claude-plugin/marketplace.json               # marketplace registration
```

The output is ground truth for what exists. Planning against it avoids the "subagent not found" / "unknown CLI" class of bug. (As shipped: Codex roles `execute`/`rescue`/`review`/`adversarial-review`; Cursor roles `delegate`/`research`/`explore`; Antigravity roles `research`/`explore`; OpenCode roles `delegate`/`research`/`explore`. The Antigravity subagent files are named `antigravity-researcher`/`antigravity-explorer`; OpenCode subagents are named `opencode-delegate`/`opencode-researcher`/`opencode-explorer`. Confirm against your own `ls` — don't assume.)

## Step 2 — Verify CLI-specific strings BEFORE hardcoding them

Before hardcoding any CLI-specific string (model IDs, effort levels, sandbox/mode names, flag names) as a default, verify it. Do not ask the user to confirm these — Claude can look them up faster.

**The verification-trap:** CLIs often accept version-qualified IDs (`-preview`, `-beta`, `-exp` suffixes). Dropping the suffix produces a runtime 4xx. A model ID like `gpt-5.3` vs `gpt-5.3-codex` is not interchangeable, and Gemini-family IDs (which Antigravity surfaces) have historically used `-preview` suffixes that 404 when dropped. Every CLI has analogous traps.

### Pick ONE source proportional to the question. Stop when confident.

The verification sources form a LADDER — start with the cheapest authoritative one for the question at hand and stop as soon as you have a confident answer. Do NOT run every source for every question.

**Decision tree:**

- **Yes/no capability check** — "does `<cli>` support `--read-only`?" or "does `<cli>` have an `ask` mode?" → ONE source. Usually `<cli> --help | grep <term>` in well under a second. Done. Don't escalate.
- **Enumerating what exists** — "what modes does `<cli>` have?" or "what models does `<cli>` accept?" → ONE source. Try `<cli> --help` (or `<cli> models` / `<cli> --list-models`) first, or a vendor-docs lookup via context7 if `--help` isn't exhaustive. Escalate only if the first comes up empty or suspicious.
- **Exact canonical ID with version suffix** (e.g. "the current stable Cursor model id for the medium tier") — up to TWO sources when a wrong suffix bricks the feature. Prefer the CLI's own listing, then cross-check with vendor docs. Only read source constants on disagreement.

### The sources, in the order you'd try them

1. **`<cli> --help`, `<cli> models`, `<cli> about`, `<cli> --list-models`** — fastest. No network. Free. Authoritative for "what does this binary accept right now." **Default choice for most questions.**
2. **Vendor docs via context7** — `resolve-library-id` → `query-docs`. Good for canonical names, deprecation context, and modes not surfaced by `--help`.
3. **Web search via exa** — for recent changelogs, forum posts, or obscure flags not covered by context7.
4. **CLI source on GitHub** — `config/models.ts` constants, etc. Use when 1–3 disagree or come up empty.
5. **Prompt the CLI itself with `<cli> -p "..."`** — LAST RESORT only. Costs the user API credits and is slow. Don't reach for it for routine customize questions; docs and web search cover 99% of what this skill needs.

### Hard rules

- **Do not invoke `<cli> -p` as a research step** unless sources 1–4 are all empty. For a customize task you almost never need it.
- **Never ask one CLI about another CLI's features.** Cross-CLI interrogation hallucinates as badly as guessing. A CLI is a source only for ITSELF.
- **`plugins/multi/scripts/lib/adapters/<cli>.mjs` is the source of truth for what flags our companion actually forwards** to the CLI — check it, not just the CLI's `--help`, when a flag is involved.
- **Record the source you used inline in your response** so the user sees what you checked, and claim "unverified" honestly if sources didn't surface a confident answer.

### Resolving disagreements (rare — usually only one source is needed)

- **CLI wins** for "will it work right now."
- **Docs win** for "should I use this" (deprecation, aliasing).

## Safety checkpoint before edits

```bash
cd $REPO && git status && git add -A && git commit -m "checkpoint before customization"
```

Run this via Bash if the working tree has uncommitted changes. Skip if it's clean.

## Change types (generic, with illustrative examples)

All examples use `<cli>`, `<cli-a>`, `<cli-b>`, `<role>`, `<action>` as placeholders. Substitute the CLI/role names from your Step 1 inventory.

### 1. Swap a role between two CLIs

*User: "make `<cli-a>` handle `<role>` instead of `<cli-b>`."*

**Add the new mapping (two files):**
- `plugins/<cli-a>/commands/<action>.md` — copy from `plugins/<cli-b>/commands/<action>.md`; change the dispatch target to `multi:<cli-a>-<role>`.
- `plugins/multi/agents/<cli-a>-<role>.md` — copy from a forwarder **of the same kind** (see "Pick the right template" below); update `name:`, `description:`, the `model:`, and the Bash invocation's `--cli <cli-a> --role <role>`.

**Optionally remove the old mapping:** delete or `_disabled-`-rename `plugins/<cli-b>/commands/<action>.md` and `plugins/multi/agents/<cli-b>-<role>.md`.

**If the new role implies read-only or write behavior the target adapter doesn't already handle**, set it (change type #5 / #7) — e.g. Cursor needs the role added to `READ_ONLY_ROLES` to be read-only; Codex just needs `--read-only` vs `--write` passed by the forwarder.

**Pick the right template (this is what the old `buildPrompt` model hid):**
- A **write/agentic role** (implement, edit, refactor) → copy a write forwarder like `cursor-delegate.md` or `codex-execute.md`. These carry a **prompt-framing block** and run on **Sonnet**.
- A **read-only role** (research, explore, review) → copy a read forwarder like `codex-review.md`, `cursor-research.md`, `antigravity-researcher.md`, or `opencode-researcher.md`. These have little/no framing; a pure path-bridge (no framing) can run on **Haiku**.

Every forwarder MUST keep `skills:\n  - multi-cli-runtime` in its frontmatter — that's the shared flag/failure contract. Don't drop it.

### 2. Add a net-new command for an existing CLI

*User: "add `/<cli>:<action>`."* (First confirm it doesn't already exist — run the Step 1 `find`.)

- **Create** `plugins/<cli>/commands/<action>.md` — dispatches via the `Agent` tool to `multi:<cli>-<role>`. Copy an existing command of the same kind and adjust.
- **Create** `plugins/multi/agents/<cli>-<role>.md` — thin forwarder. Copy a same-kind forwarder; update `name:`, `description:`, `model:`, and `--role <role>`. Keep `skills: [multi-cli-runtime]`.
- **Set the role's behavior in the adapter if needed** (change type #7): for a read-only role on a CLI whose adapter defaults to write (Cursor does), add the role to its read-only set; for Codex, the forwarder simply passes `--read-only`.

**Illustrative:** user says "add `/codex:explore`" (a read-only codebase-Q&A role for Codex, paralleling `/cursor:explore`). Step 2 confirms Codex can run read-only (`--read-only` → the companion uses the `read-only` sandbox).
→ Create `plugins/codex/commands/explore.md` (dispatching to `multi:codex-explore`).
→ Create `plugins/multi/agents/codex-explore.md` (copy `codex-review.md` as the read-only template; forward with `--cli codex --role explore --read-only`; Haiku is fine since it does no framing).
→ No adapter edit needed: Codex's read/write is the sandbox toggled by `--read-only`/`--write`, not a per-role map.

### 3. Disable a command or subagent

**Command (user-facing slash):**
- Delete `plugins/<cli>/commands/<action>.md` (git preserves history), OR rename to `_disabled-<action>.md` (Claude Code won't load files starting with underscore).

**Subagent (Claude's auto-dispatch target):**
- Same approach — delete or underscore-rename in `plugins/multi/agents/`.

### 4. Uninstall CLI plugins you don't need

If the user only wants some of the CLIs, the cleanest customization is no customization: don't install the plugins they skip.

```bash
claude plugin uninstall <cli>@cc-multi-cli-plugin
```

`multi` stays installed (the hub is required). CLI plugins are additive and independently installable.

### 5. Restrict a CLI's behavior (read-only, narrower tools)

Two layers, both in `plugins/multi/agents/<cli>-<role>.md`:

- **Frontmatter `tools:`** — narrow what the *forwarder itself* may do. Forwarders ship with `tools: Bash` (review additionally `Bash(git:*)`); tightening to e.g. `Bash(node:*)` keeps it from doing anything but call the companion.
- **Body / Bash invocation** — make the forwarder pass the right read-only flag so the *external CLI* can't write:
  - **Codex:** ensure the invocation passes `--read-only` (not `--write`). The companion maps that to Codex's `read-only` sandbox.
  - **Cursor:** read-only is role-driven — `research`/`explore` already run `--mode ask --force` (no writes). To force an otherwise-write role read-only, ensure its role name is in `READ_ONLY_ROLES` in `cursor.mjs` (change type #7), or route it through a read-only role.
  - **Antigravity:** already read-only on every role; nothing to restrict.

`plugins/multi/scripts/lib/adapters/<cli>.mjs` is the source of truth for which restriction flags that CLI's adapter actually forwards — consult it before writing one in.

### 6. Hardcode a default model (or other flag) for a subagent

Forwarder Bash invocations pass `--model` through from the user's request. To bake in a *default* that applies when the user doesn't specify one, edit the forwarder's Bash line to include `--model <name>` unconditionally and note that explicit user overrides win.

**Generic pattern** — in `plugins/multi/agents/<cli>-<role>.md`, change:

```markdown
`node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" task --cli <cli> --role <role> ...`
- Pass `--model`, `--resume`, `--fresh` as runtime controls.
```

to:

```markdown
`node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" task --cli <cli> --role <role> --model <VERIFIED-ID> ...`
- If the user's request explicitly specifies a different `--model`, use that value instead of `<VERIFIED-ID>`.
- Pass `--resume`, `--fresh` as runtime controls.
```

**Illustrative:** pinning `/cursor:research` to a specific Cursor model (e.g. `gpt-5.5-medium`). Step 2 verification confirms the exact flat id (Cursor takes flat names like `gpt-5.5-medium`, not bracketed forms) before you type it. Forgetting a required version suffix is the most common way to ship a broken forwarder.

The same pattern works for `--effort` (Codex only), or any CLI-specific flag. **Exception — Antigravity:** its headless `agy` path ignores `--model` (fixed to Gemini 3.5 Flash), so there is no per-forwarder model pin for it.

### 7. Change how a role behaves — its framing, or its read/write flags

This replaces the old "edit `buildPrompt()`" instruction. There is no `buildPrompt()`. Two distinct things you might mean:

**(a) Change how a role *frames* the prompt (tone, instructions, output format the CLI is asked for).**
Edit the **framing block inside the forwarder** `plugins/multi/agents/<cli>-<role>.md`. Write-role forwarders contain a fenced block they prepend to the user's task — e.g. `cursor-delegate.md`'s "You are Cursor in agent mode…" or `codex-execute.md`'s two model-specific blocks. Edit that block. Note the contract the framing must preserve: it is **skipped entirely when `--plan`/`--prompt-file` is used** (the file is the prompt), per `multi-cli-runtime`. Don't add framing to a pure read-only path-bridge that intentionally has none unless you also bump its model.

**(b) Change how a role maps to the CLI's *flags/permissions* (read vs write, mode).**
Edit the **adapter** `plugins/multi/scripts/lib/adapters/<cli>.mjs` — but the mechanism is CLI-specific, so verify first:
- **Cursor:** roles map to headless flags in `buildHeadlessArgs()`, and which roles are read-only is the `READ_ONLY_ROLES` set. To make a new role read-only, add it to that set (e.g. add `"reviewer"` so a `cursor-review` role runs `--mode ask`). Touch only these role-mapping pieces — the spawn/parse code is the transport; breaking it breaks the CLI.
- **Codex:** there is no per-role flag map; read vs write is the sandbox chosen from `--write`/`--read-only` in `lib/commands/task.mjs`. You change a Codex role's behavior by what the forwarder passes, not by editing the adapter.
- **Antigravity:** read-only only; no role→flag map to change.
- **OpenCode:** roles map to flags in `buildHeadlessArgs()` and the `READ_ONLY_ROLES` set in `opencode.mjs`. OpenCode has **no `--read-only` flag** — for read-only roles the adapter injects a custom oc-* primary agent via `OPENCODE_CONFIG_CONTENT` with write/edit/bash denied, plus an `OPENCODE_PERMISSION` deny floor. **`--effort` is NOT supported** by OpenCode (it is silently ignored by the adapter). `--until-done` IS supported. To add a new read-only role, add it to `READ_ONLY_ROLES` in `opencode.mjs` — everything else follows automatically.

If you're unsure which of (a)/(b) the user means, the rule of thumb: wording/instructions/output-format → (a), the subagent `.md`; "let it write" / "keep it read-only" / "use ask mode" → (b), the adapter or the forwarder's flags.

## Operator escape hatches (for diagnosing or working around upstream CLI issues)

When a CLI misbehaves upstream — a broken release, a regression, an obscure config requirement — these knobs give the user direct control without code changes. The adapter code reads them automatically; surface the relevant one in your answer when an upstream bug is the root cause.

- **`CURSOR_AGENT_PATH=<absolute-path>`** — point the Cursor adapter at a specific `agent` binary (e.g. an older cached build under `~/AppData/Local/cursor-agent/versions/<version>/`). Useful when a new Cursor release regresses and the user wants to pin a known-good one. `findCursorBinary()` checks this before `where`/`which` and the Windows fallback path.
- **`AGY_CLI_PATH=<absolute-path>`** — point the Antigravity adapter at a specific `agy` binary (`findAgyBinary()` checks it before PATH and the Windows fallback `$LOCALAPPDATA/agy/bin/agy.exe`). The operator requirement is that `agy` is installed and signed in (run `agy` once interactively); if it isn't, the adapter reports "not signed in." `agy` headless does **not** honor `--model` (Gemini 3.5 Flash only).
- **`OPENCODE_CLI_PATH=<absolute-path>`** — point the OpenCode adapter at a specific `opencode` binary. `findOpencodeBinary()` checks this first; if unset it resolves the bare name `opencode` and lets `process.mjs` `resolveWindowsCommand` pick the `.cmd` shim on Windows. Never resolves to `opencode.exe` (the stale bun build).
- **`OPENCODE_CLI_DEFAULT_MODEL=<model-id>`** — override the default model for all OpenCode calls (default: `opencode/claude-opus-4-8`). Use a Zen model (`opencode/*`) or an OpenAI/Google/Copilot/Ollama model to get real token offload. **Avoid `anthropic/*` models** — they reuse your Claude Code subscription and provide zero offload.
- **Per-CLI MCP config files** — when a CLI doesn't pick up MCP servers the way you expect, populate the CLI's own config: Cursor reads `~/.cursor/mcp.json`; Codex reads `~/.codex/config.toml`; Antigravity's `agy` reads MCP servers from its Gemini-CLI config `~/.gemini/settings.json`; **OpenCode reads MCP servers from its own `opencode.json`** (use OpenCode's interactive wizard to configure these — the `/multi:setup` wizard does NOT manage `opencode.json`). Use these as the fallback when a server is "missing."

### Switching a CLI's transport (headless ↔ ACP)

Cursor and OpenCode can run over two transports. **Headless** (`agent -p` / `opencode run`) is the default. **ACP** (Agent Client Protocol, structured JSON-RPC over stdio via the official `@agentclientprotocol/sdk`, client at `lib/acp/client.mjs`) is opt-in and adds in-protocol model selection, session modes, and a real `session/cancel`. Select per CLI with an env var — no code edit:

- **`MULTI_TRANSPORT_CURSOR=acp|headless`** (default `headless`)
- **`MULTI_TRANSPORT_OPENCODE=acp|headless`** (default `headless`)

Read at invoke time, so they can live in `~/.claude/settings.json` `env`, a shell export, or be flipped per session. With no flag set, behavior is identical to the headless default. **Codex and Antigravity have no ACP path** (Codex exposes no native ACP; `agy` doesn't implement it) — leave them on their native transports. ACP-only knobs: `MULTI_ACP_INACTIVITY_MS` / `MULTI_ACP_OVERALL_MS` override the watchdog windows (a CLI that spawns then hangs silently is caught by the inactivity watchdog, which covers the handshake too). When a CLI is on the ACP path, read-only roles are enforced via the agent's own mechanism (Cursor: `session/set_mode` → `ask`; OpenCode: the same `OPENCODE_PERMISSION` deny floor as headless), and model pinning goes through `session/set_config_option` against the live options list — so the per-forwarder model-pin and read-only customizations above work on either transport.

### Diagnosing a CLI that hangs or returns nothing

The shipped CLIs are driven headlessly, so the first diagnostic is always the captured output:

- **`2>&1` on the companion call** (the forwarders already append it) surfaces the CLI's stderr — the single most useful signal. A bad model id, an auth failure, or a sandbox block all print there.
- **Cursor specifics:** `agent --version` — a few early-2026 builds predate the headless MCP-tools fix; the adapter warns when it detects a known-bad build (`KNOWN_BROKEN_CURSOR_VERSIONS` in `cursor.mjs`). Cursor's **shell tool is slow/unreliable on Windows** (host-PATH/WSL, open upstream), which is why `/cursor:delegate` defers build/test verification to the caller — file writes and web/codebase reads are unaffected. For write roles the adapter parses Cursor's documented `--output-format stream-json` events; a run that emits no `result` event with a non-zero exit is almost always a startup error visible in stderr.
- **Antigravity specifics:** `agy`'s headless stdout is empty upstream (gemini-cli#27466), so the adapter recovers the answer from the on-disk transcript JSONL. If a run returns nothing, check that `agy --version` works and that `~/.gemini/oauth_creds.json` exists (signed in). A `.tmp→.pb` "Access denied" line in agy's own log is benign on Windows and does not block the transcript.
- **`ACP_TRACE=1`:** traces the ACP JSON-RPC wire to stderr. Useful only when a CLI is actually running over ACP — i.e. Cursor or OpenCode with `MULTI_TRANSPORT_<CLI>=acp` set (see the transport-toggle section below), or a user-added ACP CLI. On the default headless path (and for Codex/Antigravity, which have no ACP) it's a no-op.

## What NOT to touch (unless adding a new transport)

These are shared infrastructure; `multi-cli-anything` is the skill for extending them.

- `plugins/multi/scripts/multi-cli-companion.mjs` (the ~100-line dispatcher) and `plugins/multi/scripts/lib/commands/*.mjs` (`task`, `review`, `jobs`, `setup`, `shared`) — the command handlers.
- `plugins/multi/scripts/lib/adapters/registry.mjs` — the adapter registry (you edit this only to *add* a CLI, via `multi-cli-anything`).
- `plugins/multi/scripts/lib/job-control.mjs`, `state.mjs`, `render.mjs`, `workspace.mjs`, `tracked-jobs.mjs`, `app-server.mjs`, and the ACP client layer `lib/acp/` (`client.mjs`, `resolve.mjs`, `diagnostics.mjs`). (A legacy `lib/acp-client.mjs` also exists, predating the `lib/acp/` layer and slated for deletion — don't touch or build on it either.)
- The existing adapters' transport code (`codex*.mjs`, `cursor.mjs`, `antigravity.mjs`, `opencode.mjs`) — except the role-mapping pieces called out in change type #7.
- `plugins/multi/hooks/hooks.json` (unless adding a new hook).

## Verify after edits — YOU (Claude) run the refresh, not the user

**You execute the refresh commands yourself via Bash.** Do not hand commands to the user to type. The only thing you can't do is restart Claude Code itself; flag that explicitly when it's needed.

**Always run first:**

```bash
claude plugin validate $REPO
```

Catches JSON/schema/frontmatter errors before any reinstall. Fix errors and re-run before proceeding. If you edited an adapter, also `node --check plugins/multi/scripts/lib/adapters/<cli>.mjs` and run `npm test` in `$REPO` (the offline suite, no tokens).

**Then refresh based on what you touched:**

| What you edited | What you run via Bash | User action required? |
|---|---|---|
| Command file (`plugins/<cli>/commands/*.md`) | `claude plugin install <cli>@cc-multi-cli-plugin --force` | None — command changes are live after reinstall |
| Subagent (`plugins/multi/agents/*.md`) | `claude plugin install multi@cc-multi-cli-plugin --force` | **Yes — user must restart Claude Code.** Subagent definitions are cached at session start. |
| Adapter / companion script (`plugins/multi/scripts/...`) | Nothing — the companion respawns on each invocation | None |
| New plugin added to `marketplace.json` | `claude plugin marketplace update cc-multi-cli-plugin` then `claude plugin install <new-plugin>@cc-multi-cli-plugin` | None for the new plugin itself; restart if it has subagents |
| `plugins/multi/hooks/hooks.json` | `claude plugin install multi@cc-multi-cli-plugin --force` | **Yes — restart** |

## End-to-end workflow Claude follows

1. Step 0: locate `$REPO`.
2. Step 1: discover current inventory via `ls` / `find` / `registry.mjs`.
3. Step 2: verify any CLI-specific strings the user mentioned (model IDs, modes, flags).
4. Safety checkpoint commit.
5. Make file edits per the relevant change type(s) — touching the artifact that *owns* the change (command / forwarder / adapter), keeping `skills: [multi-cli-runtime]` on every forwarder.
6. Run `claude plugin validate $REPO` (and `npm test` / `node --check` if you touched a script).
7. Run the relevant `claude plugin install ... --force` commands via Bash (one per affected plugin).
8. Commit the changes via Bash: `cd $REPO && git add -A && git commit -m "customize: <summary>"`.
9. Report to user:
   - If subagents or hooks changed: end with *"Please restart Claude Code — [reason]. After restart, try `/<cli>:<action> <test-prompt>` to verify."*
   - Otherwise: give a test command they can run right now without restart.

Claude restart is the one thing you can't do — don't pretend you can. Reinstalling, validating, and committing are all yours.

## Illustrative walk-through: give one CLI a read-only role another CLI owns

User says: *"Make Cursor my reviewer instead of Codex."* (Cursor has no `review` role yet; this exercises all four moving parts.)

1. `claude plugin marketplace list` → confirm `cc-multi-cli-plugin` lives in an editable location.
2. Step 1: `ls $REPO/plugins/multi/agents/` → see `codex-review` exists, no `cursor-review`. `cat .../adapters/cursor.mjs` → note `review`/`reviewer` is **not** in `READ_ONLY_ROLES`, so a `cursor` review role would default to write mode.
3. Step 2: confirm Cursor's read-only mode is `--mode ask` (`agent --help`) — it is; the adapter already uses it for `research`/`explore`.
4. Safety commit if the tree is dirty.
5. Adapter: add `"reviewer"` (and/or `"review"`) to `READ_ONLY_ROLES` in `cursor.mjs` so the role runs `--mode ask --force` (read-only). `node --check` it.
6. Forwarder: create `plugins/multi/agents/cursor-review.md` — copy `codex-review.md` (the read-only template), set `name: cursor-review`, keep `skills: [multi-cli-runtime]`, set `model: haiku` (pure bridge, no framing), and forward `task --cli cursor --role reviewer --read-only`.
7. Command: create `plugins/cursor/commands/review.md` — copy `plugins/codex/commands/review.md`, change the dispatch to `multi:cursor-review`.
8. Optionally disable Codex's reviewer (delete/underscore `codex-review.md` + `plugins/codex/commands/review.md`) if Codex shouldn't review anymore — or leave it for both.
9. `npm test` + `claude plugin validate $REPO` via Bash — must pass.
10. `claude plugin install cursor@cc-multi-cli-plugin --force` + `claude plugin install multi@cc-multi-cli-plugin --force`, via Bash.
11. Commit via Bash.
12. Tell the user: *"Done. Please restart Claude Code — I touched a subagent file and the definitions are session-cached. After restart, try `/cursor:review` on a small diff."*

Substitute any other CLI/role pair and the same four-part pattern applies — identify which artifact owns the change, edit it, validate, reinstall, restart if a subagent changed.

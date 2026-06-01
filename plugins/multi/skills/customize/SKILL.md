---
name: customize
description: Rewire which CLI handles which role in cc-multi-cli-plugin, OR diagnose/work around an upstream CLI quirk via env vars and config files. Use when the user asks to swap CLIs, change a subagent's target CLI, add or disable a subagent or command, restrict a CLI, hardcode a model, or modify a role's prompt template — and also when a CLI is misbehaving (hangs, missing tools, broken release) and the user needs operator escape hatches like CURSOR_AGENT_PATH, ACP_TRACE, or per-CLI MCP config tuning. Works for any CLI in the marketplace — the three default CLIs (Codex, Cursor, Antigravity) and any additional CLIs the user added via the multi-cli-anything skill. Trigger phrases include "swap Codex and Cursor", "make Antigravity the researcher", "disable cursor-explore", "restrict Codex to read-only", "change which CLI handles implementation", "add /<cli>:<command>", "only install the plugins I need", "hardcode a model for <some-role>", "use cursor to research a library", "cursor is hanging / broken / stuck", "pin an older cursor build", "see what ACP traffic the CLI is sending".
---

# Customize cc-multi-cli-plugin

cc-multi-cli-plugin is a **multi-plugin marketplace**: one hub plugin (`multi`) plus one thin plugin per AI CLI the user has wired up. Customization is explicit file edits across those plugins. No runtime config layer.

**This skill is CLI-agnostic.** Every instruction below works for any CLI in the marketplace — the three shipped defaults (Codex, Cursor, Antigravity) and any CLIs added later via the `multi-cli-anything` skill (OpenCode, Aider, etc.). Concrete examples use specific CLI names for clarity, but apply the same pattern to any CLI.

## The shape every customization touches

Three file types, consistent across all CLIs:

| File | Pattern | Produces |
|---|---|---|
| Slash-command entry point | `plugins/<cli>/commands/<action>.md` | `/<cli>:<action>` |
| Subagent (thin forwarder to the companion) | `plugins/multi/agents/<cli>-<role>.md` | `subagent_type: "multi:<cli>-<role>"` |
| Adapter (CLI-specific transport + `buildPrompt` role→prefix map) | `plugins/multi/scripts/lib/adapters/<cli>.mjs` | What the companion actually invokes |

A customization edits one or more of these. The skill below teaches you which files change for each kind of customization.

## Step 0 — Locate the plugin repo

Before editing anything, determine WHICH files to edit. Three scenarios:

1. **Check `claude plugin marketplace list`** — find the `installLocation` for `cc-multi-cli-plugin`.
2. **Classify the install:**
   - If `installLocation` is a local directory the user controls (dev clone, fork they own) — **edit those files directly.** Changes are live.
   - If `installLocation` is under `~/.claude/plugins/marketplaces/cc-multi-cli-plugin/` and sourced from a GitHub repo the user does NOT own — **edits there will be overwritten** on the next `claude plugin marketplace update`. STOP and tell the user they need to fork the repo, clone their fork, and re-register that clone as the marketplace source.
3. **Ask the user** if you can't tell which scenario applies.

Record the path you'll edit as `$REPO`. All subsequent file paths are relative to `$REPO`.

## Step 1 — Discover the current inventory (don't rely on memory)

Users may have added CLIs via `multi-cli-anything` that aren't in any documentation. Always run these before planning changes:

```bash
ls $REPO/plugins/                            # CLI plugins installed
ls $REPO/plugins/multi/agents/               # subagents
find $REPO/plugins -name "*.md" -path "*/commands/*"   # commands
cat $REPO/.claude-plugin/marketplace.json    # marketplace registration
```

The output is ground truth for what exists. Planning against it avoids the "subagent not found" class of bug.

## Step 2 — Verify CLI-specific strings BEFORE hardcoding them

Before hardcoding any CLI-specific string (model IDs, effort levels, sandbox modes, flag names, slash commands, mode names) as a default, verify it. Do not ask the user to confirm these — Claude can look them up faster.

**The verification-trap:** CLIs often accept version-qualified IDs (`-preview`, `-beta`, `-exp` suffixes). Dropping the suffix produces a runtime 4xx. For example a model ID like `gpt-5.4` vs `gpt-5.4-mini` is not interchangeable, and Gemini-family IDs (which Antigravity surfaces) have historically used `-preview` suffixes that 404 when dropped. Every CLI has analogous traps.

### Pick ONE source proportional to the question. Stop when confident.

Do NOT run every source for every question. The verification sources form a LADDER — start with the cheapest authoritative one for the question at hand and stop as soon as you have a confident answer.

**Decision tree:**

- **Yes/no capability check** — "does `<cli>` have a `/<slash-command>` command?" or "does `<cli>` support `--read-only`?" → ONE source. Usually `<cli> --help | grep <term>` in well under a second. Done. Don't escalate.

- **Enumerating what exists** — "what slash commands does `<cli>` have?" or "what models does `<cli>` accept?" → ONE source. Try `<cli> --help` first, or a vendor-docs lookup via context7 if `--help` isn't exhaustive. Escalate to a second source only if the first comes up empty or suspicious.

- **Exact canonical ID with version suffix** (e.g., "what's the current stable model ID for Antigravity's flash tier?") — up to TWO sources when the answer must be typed into code and a wrong suffix bricks the feature. Prefer (a) asking the CLI itself via a natural-language prompt, then cross-check with (b) vendor docs. Only escalate to reading source constants on disagreement.

### The sources, in the order you'd try them

1. **`<cli> --help`, `<cli> models`, `<cli> about`** — fastest. No network. Free. Authoritative for "what does this binary accept right now." **Default choice for most questions.**

2. **Vendor docs via context7** — `resolve-library-id` → `query-docs`. Good for canonical names, deprecation context, and slash commands not surfaced by `--help`. Use this as the primary fallback when `--help` doesn't answer.

3. **Web search via exa** — for recent changelogs, forum posts, or obscure flags not covered by context7.

4. **CLI source on GitHub** — `config/models.ts` constants, etc. Use when 1–3 disagree or come up empty.

5. **Prompt the CLI itself with `<cli> -p "..."`** — LAST RESORT only. This costs the user API credits and is slow. Don't reach for it for routine customize questions; docs and web search cover 99% of what this skill needs.

### Hard rules

- **Do not invoke `<cli> -p` as a research step** unless sources 1–4 are all empty. For a customize task (small edit, known CLI, verifiable via docs), you almost never need it.
- **Never ask one CLI about another CLI's features.** Cross-CLI interrogation hallucinates as badly as guessing. Only use a CLI as a source for ITSELF, and even then only as a last resort.
- **Record the source you used inline in your response** so the user sees which sources you checked.
- **Claim "unverified" honestly** if a string is rare or sources didn't surface a confident answer. Don't ship guesses as verified facts.

### Resolving disagreements (rare — usually only one source is needed)

- **CLI wins** for "will it work right now."
- **Docs win** for "should I use this" (deprecation, aliasing).

### Also verify per CLI

- **Slash commands and modes** — vary by CLI and by version; new ones land regularly. Enumerate via the three-source check before referencing one.
- **Runtime flags** (sandbox modes, effort levels, read-only toggles) — check `--help` for exact spelling.
- **OS quirks** — Windows `.cmd` shims, shell requirements, PATH differences, path-separator handling.
- **`plugins/multi/scripts/lib/adapters/<cli>.mjs`** is the source of truth for what flags our companion forwards to the CLI.

**Record findings inline in your response** (so the user can double-check), then proceed to file edits without asking for confirmation on verifiable facts.

## Safety checkpoint before edits

```bash
cd $REPO && git status && git add -A && git commit -m "checkpoint before customization"
```

Run this via Bash if the working tree has uncommitted changes. Skip if it's clean.

## Change types (generic, with illustrative examples)

All examples use `<cli>`, `<cli-a>`, `<cli-b>`, `<role>`, `<action>` as placeholders. Substitute the CLI names from your Step 1 inventory.

### 1. Swap a role between two CLIs

*User: "make `<cli-a>` handle `<role>` instead of `<cli-b>`."*

**Edit two files to ADD the new mapping:**
- `plugins/<cli-a>/commands/<action>.md` — copy from `plugins/<cli-b>/commands/<action>.md`; change the dispatch target to `multi:<cli-a>-<role>`.
- `plugins/multi/agents/<cli-a>-<role>.md` — copy from `plugins/multi/agents/<cli-b>-<role>.md`; update `name:`, description, and the Bash invocation to `--cli <cli-a> --role <role>`.

**Optionally REMOVE the old mapping:**
- Delete or `_disabled-`-rename `plugins/<cli-b>/commands/<action>.md` and `plugins/multi/agents/<cli-b>-<role>.md`.

**If the new role doesn't exist in the target adapter's `buildPrompt()`**, add it (see change type #7).

**Illustrative:** user says "make Codex the executor instead of Cursor."
→ Create `plugins/codex/commands/execute.md` (dispatching to `multi:codex-execute`) — if it doesn't already exist.
→ Create `plugins/multi/agents/codex-execute.md` (forwarding to `--cli codex --role execute`).
→ Remove or disable the cursor counterparts if Cursor shouldn't execute anymore.

### 2. Add a net-new command for an existing CLI

*User: "add `/<cli>:<action>`."*

- **Create** `plugins/<cli>/commands/<action>.md` — dispatches via `Agent` tool to `multi:<cli>-<role>`. Copy any existing command file as a template and adjust.
- **Create** `plugins/multi/agents/<cli>-<role>.md` — thin forwarder. Copy any existing subagent file; update `name:`, description, and the Bash invocation's `--role <role>` field.
- **If `<role>` is new to this CLI's adapter**, update `plugins/multi/scripts/lib/adapters/<cli>.mjs`'s `buildPrompt()` to map the new role to whatever slash-command prefix the CLI expects (see change type #7).

**Illustrative:** user says "add `/cursor:research`" and your verification in Step 2 confirmed Cursor can run a read-only research role.
→ Create `plugins/cursor/commands/research.md` (dispatching to `multi:cursor-researcher`).
→ Create `plugins/multi/agents/cursor-researcher.md` (forwarding with `--cli cursor --role researcher`).
→ Edit `plugins/multi/scripts/lib/adapters/cursor.mjs` to add `researcher: ""` (or the appropriate prefix) to the `buildPrompt()` prefix map.

### 3. Disable a command or subagent

**Command (user-facing slash):**
- Delete `plugins/<cli>/commands/<action>.md` (git preserves history).
- OR rename to `_disabled-<action>.md` (Claude Code won't load files starting with underscore).

**Subagent (Claude's auto-dispatch target):**
- Same approach — delete or underscore-rename in `plugins/multi/agents/`.

### 4. Uninstall CLI plugins you don't need

If the user only wants some of the CLIs, the cleanest customization is no customization: don't install the plugins they skip.

```bash
claude plugin uninstall <cli>@cc-multi-cli-plugin
```

`multi` stays installed (the hub is required). CLI plugins are additive and independently installable.

### 5. Restrict a CLI's behavior (read-only, narrower tools, sandboxed)

Edit `plugins/multi/agents/<cli>-<role>.md`:
- **Frontmatter `tools:`** — narrow to a restricted Bash pattern (e.g., `Bash(echo:*)`) to prevent broader tool use.
- **Body:** ensure the Bash invocation includes the appropriate restriction flag (`--read-only`, `--no-write`, `--sandbox <mode>`, or whatever that CLI's adapter exposes — verify via Step 2).

Consult `plugins/multi/scripts/lib/adapters/<cli>.mjs` for the flags that CLI's adapter forwards.

### 6. Hardcode a default model (or other flag) for a subagent

Subagent Bash invocations pass `--model` through from the user's request. To bake in a *default* model that applies when the user doesn't specify one, edit the subagent's Bash line to include `--model <name>` unconditionally, and update the forwarding rules to note user overrides win.

**Generic pattern** — edit `plugins/multi/agents/<cli>-<role>.md`'s forwarding rules block. Change:

```markdown
- Use exactly one `Bash` call to invoke:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" task --cli <cli> --role <role> ...`
- Pass `--model`, `--resume`, `--fresh` as runtime controls.
```

to:

```markdown
- Use exactly one `Bash` call to invoke:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" task --cli <cli> --role <role> --model <VERIFIED-ID> ...`
- If the user's request explicitly specifies a different `--model`, use that value instead of `<VERIFIED-ID>`.
- Pass `--resume`, `--fresh` as runtime controls.
```

**Illustrative:** pinning `/cursor:research` to a specific Cursor model (e.g. `gpt-5.5-medium`). Step 2 verification confirms the exact ID (including any version suffix) before you type it. The edit pins `--model <verified-id>` with override rules preserved. Forgetting a required version suffix is the most common way to ship a broken subagent. (Antigravity is the exception — its headless `agy` path ignores `--model`; see below.)

The same pattern works for `--effort`, `--sandbox`, `--reasoning-effort`, or any CLI-specific flag.

### 7. Change a role's prompt template (slash-command prefix)

Role-specific prompt prefixes live in each adapter's `buildPrompt()` function in `plugins/multi/scripts/lib/adapters/<cli>.mjs`. Generic shape:

```js
function buildPrompt(role, userTask) {
  const prefix = { <role1>: "<cli-slash-command-1> ", <role2>: "<cli-slash-command-2> " }[role] ?? "";
  return prefix + userTask;
}
```

Edit the mapping to change how a role's prompt gets prefixed, or to add a new role mapping. Only touch `buildPrompt()` — other edits to adapter code risk breaking the transport.

## Operator escape hatches (for diagnosing or working around upstream CLI issues)

When a CLI misbehaves upstream — a broken release, a regression, an obscure config requirement — these env vars and config files give the user direct control without code changes:

- **`CURSOR_AGENT_PATH=<absolute-path>`** — point our Cursor adapter at a specific binary (e.g. an older cached build at `~/AppData/Local/cursor-agent/versions/<old-version>/index.js`). Useful when a new Cursor release breaks ACP and the user wants to pin a working older one. The `findCursorBinary()` helper checks this before falling back to PATH.
- **`ACP_TRACE=1`** — turns on `[acp-trace] <- REQ/RES/NOTIF <method>` lines on stderr for any ACP-based CLI invocation. Single most useful diagnostic when an agent silently hangs — tells you exactly what JSON-RPC traffic is or isn't crossing the wire. Off by default. (Antigravity does not use ACP, so this has no effect on `--cli antigravity`.)
- **`AGY_CLI_PATH=<absolute-path>`** — point our Antigravity adapter at a specific `agy` binary (`findAgyBinary()` checks it before PATH and the Windows fallback `$LOCALAPPDATA/agy/bin/agy.exe`). Note `agy` headless does **not** honor `--model` — the model is whatever `agy` is configured to use (Gemini 3.5 Flash by default), so there is no per-subagent model pin for Antigravity. The operator requirement is that `agy` is installed and signed in (run `agy` once interactively); if it isn't, the adapter reports "not signed in."
- **Per-CLI MCP config files** (`~/.cursor/mcp.json`) — when a CLI ignores `mcpServers` passed via ACP `session/new` (Cursor in `agent acp` mode does, per Cursor staff), populate the CLI's own config file as a fallback. (Codex uses `~/.codex/config.toml`; Antigravity's `agy` reads MCP servers from its Gemini-CLI config `~/.gemini/settings.json`, not a wizard-managed file.)

These are knobs the user can twist; the adapter code reads them automatically. Surface them in the user-facing answer when an upstream CLI bug is the root cause.

## What NOT to touch (unless adding a new transport)

These are shared infrastructure; `multi-cli-anything` is the skill for extending them.

- `plugins/multi/scripts/lib/job-control.mjs`, `state.mjs`, `render.mjs`, `workspace.mjs`, `tracked-jobs.mjs`
- `plugins/multi/scripts/lib/acp-client.mjs`, `app-server.mjs`, `acp-diagnostics.mjs`
- `plugins/multi/scripts/multi-cli-companion.mjs` (unless adding a new adapter — use `multi-cli-anything`)
- `plugins/multi/hooks/hooks.json` (unless adding a new hook)

## Verify after edits — YOU (Claude) run the refresh, not the user

**You execute the refresh commands yourself via Bash.** Do not hand commands to the user to type. The only thing you can't do is restart Claude Code itself; flag that explicitly when it's needed.

**Always run first:**

```bash
claude plugin validate $REPO
```

Catches JSON/schema errors before any reinstall. Fix errors and re-run before proceeding.

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
2. Step 1: discover current inventory via `ls` / `find`.
3. Step 2: verify any CLI-specific strings the user mentioned (model IDs, slash commands, modes).
4. Safety checkpoint commit.
5. Make file edits per the relevant change type(s).
6. Run `claude plugin validate $REPO` via Bash.
7. Run the relevant `claude plugin install ... --force` commands via Bash (one per affected plugin).
8. Commit the changes via Bash: `cd $REPO && git add -A && git commit -m "customize: <summary>"`.
9. Report to user:
   - If subagents or hooks changed: end with *"Please restart Claude Code — [reason]. After restart, try `/<cli>:<action> <test-prompt>` to verify."*
   - Otherwise: give a test command they can run right now without restart.

Claude restart is the one thing you can't do — don't pretend you can. Reinstalling, validating, and committing are all yours.

## Illustrative walk-through: swap two CLIs' roles

User says: *"Make Codex the executor and Cursor the researcher."*

1. `claude plugin marketplace list` → confirm `cc-multi-cli-plugin` lives in an editable location.
2. `ls $REPO/plugins/` → confirm both `codex/` and `cursor/` plugins exist. `ls $REPO/plugins/multi/agents/` → see current subagent set.
3. No CLI-specific strings mentioned; skip Step 2 verification.
4. Safety commit if needed.
5. Create `plugins/multi/agents/codex-execute.md` (copy from `cursor-delegate.md`, change name and `--cli codex --role execute`) — if it doesn't already exist.
6. Create `plugins/multi/agents/cursor-researcher.md` (copy from an existing read-only forwarder, change to `--cli cursor --role researcher`).
7. Create `plugins/codex/commands/execute.md` (copy from `plugins/cursor/commands/delegate.md`, change dispatch to `multi:codex-execute`) — if it doesn't already exist.
8. Create `plugins/cursor/commands/research.md` (copy from an existing command, change dispatch to `multi:cursor-researcher`).
9. Optionally delete or `_disabled-` the originals.
10. `claude plugin validate $REPO` via Bash — must pass.
11. `claude plugin install codex@cc-multi-cli-plugin --force` + cursor + multi, via Bash.
12. Commit via Bash.
13. Tell the user: *"Done. Please restart Claude Code — I touched subagent files and the definitions are session-cached. After restart, try `/codex:execute create /tmp/hello.py that prints 'hi'`."*

Substitute any other pair of CLIs and the same steps apply.

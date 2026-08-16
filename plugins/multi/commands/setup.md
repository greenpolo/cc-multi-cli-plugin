---
description: One-shot setup wizard — detects CLIs, configures Exa + Context7 MCPs on each
argument-hint: "[--dry-run] [--enable-review-gate|--disable-review-gate]"
allowed-tools: Read, Edit, Write, Bash, AskUserQuestion
---

## Review-gate toggle (short-circuit)

If `$ARGUMENTS` contains `--enable-review-gate` or `--disable-review-gate`, this is a review-gate toggle, NOT a full setup run. Do ONLY this, then stop:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" setup --json $ARGUMENTS
```

Present the resulting status (it reflects the new review-gate state) and do not run any of the wizard steps below.

---

You are running the setup wizard for cc-multi-cli-plugin. Work through these steps in order, using your native tools. Do NOT invoke subagents. Do NOT run the plugin's companion scripts (except the review-gate short-circuit above and the Antigravity detection probe noted in Step 1).

If the user passed `--dry-run` anywhere in $ARGUMENTS, enumerate changes but make NO writes.

## Step 1 — Detect installed CLIs

This plugin supports four CLIs: **Codex**, **Cursor**, **Antigravity**, and **OpenCode**.

Run each probe via Bash:

- `codex --version`
- Cursor: the binary is named `agent` (not `cursor-agent`). Try `agent --version` first. On Windows the installer does NOT add it to PATH — always fall back to `$LOCALAPPDATA/cursor-agent/agent.cmd --version` (a.k.a. `C:/Users/<name>/AppData/Local/cursor-agent/agent.cmd`). Remember whichever path works; use it throughout the rest of setup.
- Antigravity: the binary is `agy` (Google's Antigravity CLI). Try `agy --version`. On Windows the installer drops it at `$LOCALAPPDATA/agy/bin/agy.exe` and may not add it to PATH. The companion's setup probe (`node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" setup --json`) reports whether `agy` is detected. (EXPERIMENTAL; read-only research/explore only.)
- OpenCode: the binary is `opencode`. Try `opencode --version`. On Windows, npm installs a `.cmd` shim; a stale bun `opencode.exe` in PATH may shadow it — the adapter resolves only the `.cmd` shim, never the `.exe`. Install via `npm install -g opencode-ai`.

Tabulate which succeed. For each failure, tell the user the install command:

- Codex: `npm install -g @openai/codex`
- Cursor: `curl https://cursor.com/install -fsS | bash` (Unix) or `irm 'https://cursor.com/install?win32=true' | iex` (Windows PowerShell). After install, the binary lives at `$LOCALAPPDATA/cursor-agent/agent.cmd` on Windows and is not on PATH.
- Antigravity: install the **`agy` CLI** from https://antigravity.google, then run `agy` once interactively to sign in with your Google account. The desktop app is not required.
- OpenCode: `npm install -g opencode-ai`.

Continue only with the CLIs that are installed. Do not block on missing ones.

**No CLIs detected:** if none of Codex, Cursor, `agy`, or `opencode` is installed, ABORT setup before any further step. Do not prompt for API keys, do not install plugins, do not configure MCPs. Print:

> *"None of Codex, Cursor, Antigravity, or OpenCode is available. Install at least one (commands above) and re-run `/multi:setup`. Nothing was changed."*

Then exit. The wizard has no productive work without at least one CLI to configure.

## Step 1.5 — Ensure the CLI-specific plugins are installed (idempotent)

For each detected CLI, check the current install state FIRST, then act:

1. **Check what's already installed** via Bash:
   ```bash
   claude plugin list 2>&1 | grep "@cc-multi-cli-plugin" || true
   ```
   The `|| true` is required: `grep` exits 1 when the marketplace has no plugins installed yet (clean first run), and an exit-1 in a piped command can torpedo subsequent commands or be misread as an error. Treat the (possibly empty) stdout as a state signal, not as an error.

2. **For each detected CLI whose plugin is NOT yet installed**, and ONLY for those, use `AskUserQuestion` to ask whether to install it. Skip the prompt entirely if the plugin is already installed — don't ask the user about plugins they already have.

3. **Install only the plugins the user accepted.** Read the actual command list from `marketplace.json` plus the live filesystem (`ls plugins/<cli>/commands/*.md`) — do NOT hardcode a list here, since the customize skill and `multi-cli-anything` skill add commands routinely. As of v3.0.0 defaults, the shipped commands are:

   - Codex → `claude plugin install codex@cc-multi-cli-plugin` (adds `/codex:execute`, `/codex:rescue`, `/codex:review`, `/codex:adversarial-review`)
   - Cursor → `claude plugin install cursor@cc-multi-cli-plugin` (adds `/cursor:delegate`, `/cursor:research`, `/cursor:explore`)
   - Antigravity → `claude plugin install antigravity@cc-multi-cli-plugin` (adds `/antigravity:research`, `/antigravity:explore`)
   - OpenCode → `claude plugin install opencode@cc-multi-cli-plugin` (adds `/opencode:delegate`, `/opencode:research`, `/opencode:explore`)

   When announcing what each install will provide, list the actual `commands/*.md` files in that plugin directory rather than the static list above (which can drift).

4. **Report** at the end of Step 1.5:
   - `✓ <cli>: already installed` for plugins that were already there (no action taken)
   - `✓ <cli>: installed` for plugins the user accepted and just installed
   - `⚠ <cli>: skipped` for plugins the user declined
   - `✗ <cli>: install failed — <error>` for any failures (continue regardless)

**Why this matters:** `claude plugin install` is destructive — it re-fetches and overwrites the cache even for already-installed plugins. Running installs on things already present wastes time and can disrupt active development setups. Guarding with the initial check makes `/multi:setup` safely re-runnable.

## Step 1.7 — Offer to add CLI binaries to the user's PATH (optional)

**Purpose:** Pure UX. The plugin works regardless — each adapter resolves binaries via absolute path. This step is for users who want to type `agent` / `codex` / `agy` from any terminal without typing a full path. (Antigravity's `agy` may also not be on PATH on Windows; the same optional PATH treatment applies.)

**For each installed CLI with a command-line binary** (Codex, Cursor), do this check:

1. **Resolve the binary's directory.** The Step 1 detection already determined the working binary — derive its parent directory (e.g., for `C:/Users/<n>/AppData/Local/cursor-agent/agent.cmd`, the directory is `C:/Users/<n>/AppData/Local/cursor-agent`).

2. **Check if that directory is already on the user's PATH.**
   - **Windows:** `[Environment]::GetEnvironmentVariable("Path","User")` via PowerShell, then split on `;` and compare. (Don't use `$env:PATH` — that's the current process PATH, which may include parent process inheritance. The User-scope env is what `setx`/SetEnvironmentVariable actually persists.)
   - **Unix:** `echo "$PATH" | tr ':' '\n' | grep -Fxq "<dir>"` — exit 0 means present.

3. **If the directory IS already on PATH**, skip — report `✓ <cli>: binary already on PATH`.

   **Note for Git Bash users on Windows:** `which <bin>` returns "no <bin>" even when the directory IS on PATH, because Git Bash's `which` doesn't try `.cmd` / `.exe` extensions. Don't use `which` as your authoritative check — split PATH and compare directories instead. The binary works fine from PowerShell, cmd.exe, and Git Bash (using `<bin>.cmd` explicitly).

4. **If NOT on PATH**, ask via `AskUserQuestion` with TWO explicit button options. Environment mutation must be opt-in, not opt-out. Don't treat ambiguous text ("no thanks", "what does this do?") as consent.
   - **Header text:** "The `<cli>` binary lives at `<full-path>` but is not on your PATH. Adding it lets you type `<bin-name>` directly from any terminal. The change is per-user, persistent, and reversible (revert instructions printed after)."
   - **Button option 1:** "Add to PATH"
   - **Button option 2:** "Skip — leave PATH alone"
   - Only proceed with the edit on explicit "Add to PATH" selection. Free-text response → treat as Skip (safer default).

5. **On consent, do the platform-appropriate edit, idempotent:**

   **Windows (per-user, no admin):**
   ```powershell
   $current = [Environment]::GetEnvironmentVariable('Path','User')
   $dirs = $current -split ';' | Where-Object { $_ -ne '' }
   if ($dirs -notcontains '<DIR>') {
     $new = ($dirs + '<DIR>') -join ';'
     [Environment]::SetEnvironmentVariable('Path', $new, 'User')
   }
   ```
   Use `[Environment]::SetEnvironmentVariable`, NOT the legacy `setx` command — `setx` truncates PATH at 1024 chars on some Windows versions.

   **Unix:** detect the user's shell first, then append a guarded line to the matching RC file:
   - Bash: `~/.bashrc` (Linux) or `~/.bash_profile` (macOS-ish)
   - Zsh: `~/.zshrc`
   - Fish: `~/.config/fish/config.fish`
   - Detect via `$SHELL` env var. If unclear, ASK the user which shell they use rather than guessing.
   
   Append (only if not already present — `grep -Fq` first):
   ```bash
   # cc-multi-cli-plugin: added <cli> to PATH
   export PATH="<DIR>:$PATH"
   ```

6. **Report exactly what was changed and how to revert:**

   ```
   ✓ <cli>: added <DIR> to PATH
       Location of change: <Windows registry key | shell RC file>
       To revert: <one-line instruction — registry edit on Windows, remove the lines on Unix>
       Note: open a NEW terminal for the change to take effect; current shell is unaffected.
   ```

7. **Bash session inside Claude Code is also unaffected** by user-PATH changes you just made. Don't try to verify by running `<bin-name>` immediately afterward — it'll fail in the current process even though the persistent change is correct. Trust the registry/RC-file edit and move on.

**Dry-run behavior:** run the detection (steps 1-3) read-only; do NOT make the PATH edit (step 5) and do NOT prompt for consent (step 4). Report what WOULD be added, then continue. The Dry-run section at the bottom of this file is the canonical source of truth on what runs vs what's suppressed in dry-run mode — defer to it for any conflict.

## Step 2 — Verify auth

For each installed CLI, check auth:

- Codex: `codex login status` (NOT `codex whoami` — that doesn't exist)
- Cursor: invoke the resolved binary path from Step 1 (NOT a literal `agent status`). On Windows that's typically `"C:/Users/<n>/AppData/Local/cursor-agent/agent.cmd" status`. Quote the path. Use the variable you stashed in Step 1 throughout the rest of the file — never assume `agent` is on PATH.
- Antigravity: sign in by running `agy` once interactively (it opens a Google OAuth browser flow; creds are stored in the OS keyring / `~/.gemini`). The companion's setup probe reports whether `agy` appears signed in; if not, tell the user to run `agy` once and sign in.
- OpenCode: `opencode auth list` (authenticated iff exit 0 and output contains a `●` provider bullet). If not authenticated, run `opencode auth login` for the desired provider. **Token-offload warning:** if the user configures an `anthropic/*` model, those calls hit the same Claude billing as Claude Code — zero token offload. Real offload comes from `opencode/*` (Zen), `openai/*`, `google/*`, `github-copilot/*`, or `ollama/*` models. The adapter default is `opencode/claude-opus-5` (Zen, billed separately). **MCP note:** OpenCode reads MCP servers from its own `opencode.json` config, NOT from the wizard-managed files. OpenCode's interactive wizard (`opencode` run normally) can configure MCP servers; the `/multi:setup` wizard does NOT manage OpenCode's `opencode.json`. Remind the user to wire Exa/Context7 into OpenCode via `opencode`'s own MCP setup if they want those tools available there.

If unauthenticated, give the exact login command (or, for Antigravity, "run `agy` once and sign in"; for OpenCode, "run `opencode auth login`") and use `AskUserQuestion` to ask whether to pause for the user to log in or skip that CLI.

## Step 3 — Collect API keys (Exa required, Context7 optional)

### Step 3a — Look for keys the user ALREADY HAS before prompting

Claude Code and other MCP-using tools often already have these keys on the user's machine. Before bothering the user with a prompt, do this discovery pass.

Tool note: use `Bash` (not `Read`) to glob optional files and read env vars — `Read` doesn't expand `$VAR` and `~` reliably on Windows, and it errors hard on missing files. Bash with `[ -f path ] && cat path` is the safe pattern. Use `Read` only after Bash has confirmed the file exists.

For each parse below: if the file exists but is malformed (broken JSON/TOML), do NOT crash the wizard — log a one-line warning, skip that source, and continue to the next.

1. **Plugin's own stored keys:** `~/.claude/plugins/cc-multi-cli-plugin/config.json` (if exists, parse; use `exaApiKey` / `context7ApiKey` fields).
2. **Claude Code's project-level MCP config:** `~/.claude/.mcp.json` (parse JSON; look for any `mcpServers.<name>.env.EXA_API_KEY` and `.CONTEXT7_API_KEY`).
3. **Other CLI configs on the system** — since the user might already have these MCPs wired to another CLI:
   - `~/.codex/config.toml` — TOML parse; look for `mcp_servers.<any-name>.env.EXA_API_KEY` (any exa-flavored server) and `.CONTEXT7_API_KEY`.
   - `~/.cursor/mcp.json` — same idea.
4. **Shell env vars** via Bash: `echo "${EXA_API_KEY:-}"` and `echo "${CONTEXT7_API_KEY:-}"`. The `:-` guard avoids set-u failures on unset vars.

If you find a plausible key, compose a summary and ASK before using it (via `AskUserQuestion`):

> "I found what looks like an Exa key already present in `<file>`. Reuse it, or paste a different key?"
> - Option: "Reuse the key from `<file>`"
> - (implicit free-text: paste a different key)

If you find nothing, proceed to the explicit prompt (Step 3b).

### Step 3b — Prompt for keys not found in Step 3a

**Each key prompt should use EXACTLY ONE button option.** `AskUserQuestion` always has an implicit free-text input box alongside the button options — the user either clicks the button OR types their key as a free-text response. Adding a "Paste key" button is redundant with the free-text input.

### Exa API key (required for Exa MCP to function)

Ask via `AskUserQuestion`:
- **Header / question text:** "Exa API key (required for the Exa MCP to work). Get one free at https://dashboard.exa.ai. To provide one, paste the key as your response. Otherwise click Skip — Exa will be entirely OMITTED from your CLI configs (no half-broken state). You can re-run /multi:setup later when you have a key."
- **Button option:** "Skip — omit Exa from all configs"

The user either clicks Skip or pastes the key. Treat the free-text response (if any) as the API key.

**Skip semantics — single canonical behavior throughout the wizard:** if the user skips Exa, the wizard does NOT register an Exa server in any CLI's config. Empty-string in `config.json` is the "Exa not configured" signal; downstream steps (3c, 4, 5) all check this flag and treat Exa as a no-op. The Step 5 verifier expects only Context7 (not "exa + context7") when Exa was skipped.

### Context7 API key (optional)

Ask via `AskUserQuestion`:
- **Header / question text:** "Context7 API key (optional). Works without a key at free-tier rate limits. With a key (free at https://context7.com): higher rate limits + access to researchMode for deeper synthesis. To provide one, paste the key as your response. Otherwise click Skip."
- **Button option:** "Skip — use Context7 at free-tier limits"

The user either clicks Skip or pastes the key.

### Step 3c — Validate provided keys via quick API probes (fail fast)

For EACH key the user provided (reused from Step 3a or pasted in Step 3b), verify it works BEFORE writing to config files. Both probes are < 1s.

**Exa:**
```bash
curl -sS -X POST https://api.exa.ai/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <KEY>" \
  -d '{"query":"test","numResults":1}' \
  -w "\n%{http_code}" | tail -1
```
Expected: `200`. 401/403 → key is bad; ask for a correct one or Skip.

**Context7:** do NOT validate via HTTP probe. The previously-suggested `context7.com/api/v1/health` endpoint returns 400 even with a valid key (the endpoint shape is wrong / has moved). We don't have a reliable cheap probe for Context7 keys right now. Just trust the user's input and let key validity surface on first real use of `/codex:rescue` / `/cursor:research` (or whichever command first invokes the MCP). The cost of a wrong-key Context7 is one failed call, recoverable; the cost of a 400-on-every-setup-run is a bad UX every time.

If you want to confirm the key looks like the right SHAPE before writing it, do a lightweight format check: `ctx7sk-` prefix + UUID-ish body. That catches typos without burning a real probe.

If a key fails Exa validation, do NOT proceed to write it to any config file. Context7 keys are written without validation.

### Step 3d — Save

Write `~/.claude/plugins/cc-multi-cli-plugin/config.json`:

```json
{
  "exaApiKey": "<key-or-empty-string>",
  "context7ApiKey": "<key-or-empty-string>"
}
```

Create the directory with `Bash` if it doesn't exist. **File permissions:** on Unix, `chmod 600` the file. On Windows, skip the chmod — NTFS default ACLs on user-profile paths already restrict to that user. Note in your summary to the user that this file "has user-profile ACL restrictions" on Windows or "is 0600" on Unix.

Never echo either key back after capture — just confirm "Saved." If the user skipped a key, store an empty string (Step 4 treats empty-string as the "omit env block" signal).

## Step 3.5 — One-time migration from v1 (only if needed)

Older versions of this skill wrote `_cc_multi_managed: true` marker keys inside `mcpServers` entries. That's been deprecated (it broke strict JSON-schema validators that reject unknown keys). On the FIRST re-run after upgrading, those markers need to be stripped from any CLI config that has them — AND `managed-servers.json` needs to be written, since v1 users have managed entries already in place but no tracking file.

Detect by reading each CLI's config and grepping for `_cc_multi_managed`. If found:

1. Announce ONCE up front: *"Migrating from v1 marker-key tracking to v2 managed-servers.json — will strip stale markers from `<list of files>` and create the tracking file."*
2. Strip the markers inline as part of Step 4's audit (don't repeat the announcement per-CLI).
3. **Write `~/.claude/plugins/cc-multi-cli-plugin/managed-servers.json`** based on what entries are currently present in each CLI's config (post-marker-strip). Example: if Codex's config has `[mcp_servers.exa]` and `[mcp_servers.context7]` after migration, write `{"codex": ["exa", "context7"]}` for that key. This unblocks Step 3.7's fast-path on subsequent runs.

After this one-time pass on all v1 users, this code path is dead — it's intentional migration debt, not ongoing audit work.

## Step 3.7 — Fast-path early bail (read-only check)

Most re-runs of `/multi:setup` are "everything still matches canonical, nothing to do." Don't make those re-runs do 30 seconds of probes + audits + reports. Run this cheap check.

**Important — fast-path scope:** the bail terminates the WIZARD'S MCP-config work (Steps 3.5 → 4 → 5 → 6). It does NOT skip Steps 1, 1.5, or 1.7. Those are independent (CLI detection, plugin install, PATH) — they need to run regardless because new CLIs may have been installed since last run, new plugins may need installing, PATH may still be wrong. The fast-path is purely about MCP configuration idempotency, not plugin-management idempotency.

**Conditions for bail (ALL must hold):**

1. Plugin's `config.json` has both keys (or empty-strings for declined ones).
2. `~/.claude/plugins/cc-multi-cli-plugin/managed-servers.json` exists.
3. **The set of CLIs in `managed-servers.json` matches the set of installed-AND-authenticated CLIs from Steps 1 and 2.** A new CLI installed since the last run (e.g., user just installed Cursor) means the tracking file is incomplete → must NOT bail; fall through and configure the new CLI. This is the critical check — Codex's review found the prior version missed this.
4. For each CLI listed in `managed-servers.json`, the live config file contains the expected server entries with credentials matching `config.json`'s canonical values, and no stale `_cc_multi_managed` markers.
5. No conflicting same-purpose servers (Exa-purpose / Context7-purpose) exist beyond the canonical entries.

**Behavior under `--dry-run`:** Step 3.7 NEVER exits early in dry-run mode — it just prints whether a real run would bail or not, then continues to the full audit so the dry-run report is complete. Real runs use the bail to terminate.

If ALL conditions hold AND not `--dry-run` → print:

> *"`/multi:setup` quick check: all configured CLIs match canonical state. Nothing to do. (Re-run with `--full` to force re-audit.)"*

…and skip to Step 6's brief summary, exit. Steady-state re-runs finish in < 5 seconds.

If any check fails → fall through to Step 4 (full audit + reconcile).

## Step 4 — Configure MCPs per CLI (audit + reconcile)

For each installed, authenticated CLI, do the following:

1. **Locate the config file.**
   - Codex: `~/.codex/config.toml` (create if missing with `[mcp_servers]` section)
   - Cursor: `~/.cursor/mcp.json` (create if missing as `{ "mcpServers": {} }`)
   - Antigravity (`agy`): MCP servers live in `agy`'s own Gemini-CLI config (`~/.gemini/settings.json` → `mcpServers`), not a wizard-managed file. Skip Antigravity in this step (and in Steps 5–6's MCP verification/inventory). The Exa/Context7 wiring below applies only to Codex and Cursor.

2. **Back up the existing file ONLY when an edit is about to happen.** Defer this step until after the audit (substep 3 below) determines that an edit IS required. Skipping the backup when no edit will land avoids stomping on a perfectly-good `.bak` for nothing.

   When the audit confirms an edit is required, then:
   - If `<file>.bak` doesn't exist → create from current live file.
   - If `<file>.bak` exists AND its mtime is older than the live `<file>` → rotate stale `.bak` to `<file>.bak.<YYYYMMDD-HHMMSS>` (timestamped), create fresh `.bak` from current live file.
   - If `<file>.bak` exists AND its mtime is ≥ live `<file>` → already current; reuse it (the live file hasn't changed since last backup).

   **Why this matters:** the original "create on every run" rule overwrote good backups in steady-state re-runs. The "deferred + mtime-aware" rule means `.bak` reflects the state immediately before THIS run's edits, every time, with no churn on no-op runs.

3. **AUDIT existing managed entries first, then merge.** This is NOT a one-shot "additive merge" — re-runs of `/multi:setup` need to detect drift from prior versions of this skill (e.g., stale `_cc_multi_managed: true` marker keys that break strict JSON-schema validators). Audit pass:

   - Read the current config file.
   - For each existing entry that IS one of our managed servers (`exa`, `context7`, OR matches the purpose patterns from the conflict-handling section below):
     - **If it has stale marker keys** (`_cc_multi_managed`, etc.) → strip them and report `cleaned stale marker on <cli>:<server>`.
     - **If its credentials differ from the canonical config.json values** (e.g., embedded Exa key doesn't match `exaApiKey` in plugin config) → report drift, ask via `AskUserQuestion` whether to update to the canonical value or keep the existing.
     - **If its shape (command/args/env) matches what we'd write fresh** → leave alone, report `unchanged`.
   - For each canonical server we WANT to add but isn't present → proceed with merge per the templates below.

   Treat "audit + reconcile" as the default behavior, not a special case.

4. **Codex — TOML**: parse-and-replace, NOT unconditional append. The prior "append the managed block" rule was non-idempotent — re-runs would create duplicate `[mcp_servers.exa]` tables. Correct flow:

   a. Parse `~/.codex/config.toml`. If malformed, report and skip Codex (don't attempt repair).
   b. Look for the existing managed-block markers (`# BEGIN cc-multi-cli-plugin managed block` / `# END cc-multi-cli-plugin managed block`) and any pre-existing `[mcp_servers.exa]` / `[mcp_servers.context7]` tables (whether managed or user-authored).
   c. If a managed block exists already AND its content matches the canonical block we'd write → no-op for Codex this run.
   d. Otherwise: REMOVE any existing managed block (between markers) AND any pre-existing `exa` / `context7` tables that the audit determined are ours, then APPEND the canonical managed block ONCE.

   This must be a single atomic write — read full file, transform in-memory, write back. Don't append in-place mid-rewrite.

   Include `CONTEXT7_API_KEY` in Context7's env ONLY if the user provided a Context7 key; otherwise omit the env line entirely (server still works at free-tier rate limits).

   **With Context7 key:**
   ```toml
   # BEGIN cc-multi-cli-plugin managed block — do not edit by hand
   [mcp_servers.exa]
   command = "npx"
   args = ["-y", "exa-mcp-server"]
   env = { EXA_API_KEY = "<EXA_KEY_FROM_CONFIG>" }

   [mcp_servers.context7]
   command = "npx"
   args = ["-y", "@upstash/context7-mcp"]
   env = { CONTEXT7_API_KEY = "<CONTEXT7_KEY_FROM_CONFIG>" }
   # END cc-multi-cli-plugin managed block
   ```

   **Without Context7 key:** drop the `env = { ... }` line from the Context7 block.

5. **Cursor — JSON**: Merge these two servers into `mcpServers` in `~/.cursor/mcp.json`. **Do NOT add any extra marker keys** like `_cc_multi_managed` inside the server entries — strict JSON-schema validators reject unknown keys and this can break the entire config load. Include Context7's `env` block ONLY if the user provided a key.

   **Exa** (always includes its env block — required):
   ```json
   "exa": {
     "command": "npx",
     "args": ["-y", "exa-mcp-server"],
     "env": { "EXA_API_KEY": "<EXA_KEY_FROM_CONFIG>" }
   }
   ```

   **Context7 with key:**
   ```json
   "context7": {
     "command": "npx",
     "args": ["-y", "@upstash/context7-mcp"],
     "env": { "CONTEXT7_API_KEY": "<CONTEXT7_KEY_FROM_CONFIG>" }
   }
   ```

   **Context7 without key** (omit the `env` object):
   ```json
   "context7": {
     "command": "npx",
     "args": ["-y", "@upstash/context7-mcp"]
   }
   ```

   **Tracking our managed servers without breaking CLI schemas:** Instead of an inline marker, record which servers we added in a separate file — `~/.claude/plugins/cc-multi-cli-plugin/managed-servers.json`:
   ```json
   {
     "<cli-name>": ["exa", "context7"]
   }
   ```
   Update this file each time you add servers to a CLI's config. The customize skill and any future uninstall logic can read it to know which entries were added by this plugin vs the user.

   **Conflict handling — purpose-aware, not name-aware:** Before merging, scan the existing `mcpServers` object for any server that looks Exa-related (name matches `/exa/i`, OR args include `exa-mcp-server` or `@exa/`, OR httpUrl mentions `exa.ai`) and any that looks Context7-related (name matches `/context7/i`, OR args include `@upstash/context7-mcp`, OR httpUrl mentions `context7`). If you find such a server under ANY name (e.g., `exa-websearch`, `grep`, `context7-docs`):

   - Stop merging that one server silently.
   - Report the finding: "You already have `<existing-name>` configured for <Exa|Context7>: `<one-line-summary>`."
   - Ask via `AskUserQuestion`: "Keep yours" / "Replace with plugin default".
   - If "Keep yours", skip adding our entry for this CLI+server; continue with the other server. If "Replace", remove the existing entry and add ours.
   - Name-level collision (user has a server literally named `exa` or `context7`) is the same flow — not special.

   **Multiple same-purpose servers** (e.g., both `exa` and `exa-websearch` present): some users intentionally configure multiple transports for the same purpose (one stdio for offline-use + one HTTP for speed) — that's not always drift. Don't assume.

   Report the finding neutrally:

   > *"Found two Exa-purpose servers: `exa` (stdio, key ending …a3adec) and `exa-websearch` (HTTP, key ending …b254f3). They use different keys. This may be intentional (two transports) or accidental drift."*

   Ask via `AskUserQuestion`:
   - **"Intentional — leave both as configured"** (no action; user knows what they have)
   - **"Drift — consolidate to canonical (drop the non-canonical entry)"**
   - **"Skip — investigate manually"**

   Don't default to "consolidate" — both options are legitimate. The wizard's job is to surface the situation, not pick.

   **`npx` vs `httpUrl`:** the plugin's default is `npx -y <package>` (stdio transport) for consistency across systems and for cases where the user is offline after first fetch. An existing HTTP transport (e.g., `httpUrl: "https://mcp.context7.com/mcp"`) is legitimate and often faster. Do not present npx as objectively better — when the user has an HTTP version, the "Keep yours" option is reasonable.

6. Use `Read` to pull the file, `Edit`/`Write` to apply changes. Preserve the user's other keys and structure.

## Step 5 — Verify (FAST, via native MCP-list commands)

Do NOT run slow "ask the CLI to invoke a tool" probes — those take 30s-2min per CLI. Each CLI has a native `mcp` subcommand that lists configured servers instantly. Use those.

**Verify against the INTENDED state from Step 4, not against hardcoded names.** Step 4 produces a per-CLI list of "what we expected to be present after reconciliation." That intended state may legitimately differ from canonical:

- If the user chose "Keep yours" for a conflict, the canonical name (`exa`) won't be there — the user's name (`exa-websearch`) is.
- If the user skipped Exa, neither `exa` nor any Exa-purpose server should be expected.
- If the user opted to consolidate dual credentials, only the canonical entries should be present.

For each MCP-configured CLI, compare the probe output against the intended-state list. Report `✓ matches intended state` or `✗ drift` per CLI. (Antigravity has no wizard-managed MCP config — it is not verified here.)

| CLI | Probe command |
|---|---|
| Codex | `codex mcp list` (or `codex mcp` without args for help) |
| Cursor | `"<resolved-binary-path>" mcp list` (use the path stashed in Step 1, NOT a literal `agent`) |

**Empty-output gotcha — re-probe with verbose flag before declaring failure.** A CLI can exit 0 with empty stdout when servers are correctly configured but the parser used for table rendering is in a weird state. If a probe exits 0 with empty output, retry once with the CLI's verbose/debug flag (e.g. `-d`) and parse from there. ONLY after both probes return empty should you declare a failure. Exit-0-empty-stdout is not a reliable failure signal.

**Secrets warning when running verbose probes:** verbose / `-d` outputs can print env vars unmasked (Codex masks them; not every CLI does). If the user is screen-sharing or recording their terminal, this leaks the API key into scrollback. Before running any verbose probe, print:

> *"Running verbose probe for <cli> — output may include API keys. If you're sharing your screen, look away or skip this verification step."*

**If any probe fails** (non-zero exit, schema error, missing servers after both list and verbose):
- Print the exact error.
- Do NOT roll back automatically — let the user see what went wrong.
- For schema errors (a CLI rejecting unknown keys), tell the user which config file has the issue and quote the error message.

**Time budget:** each probe should complete in < 5 seconds. If one hangs, kill it (`timeout 10 <command>` via Bash) and report as failed — don't wait 2 minutes.

**Don't verify MCP server runtime reachability here.** The CLI listing each server confirms the config is valid and the CLI will spawn the server on first use. The server actually responding to queries is tested on the first real `/codex:rescue` / `/cursor:research` / etc. invocation — not in setup.

## Step 6 — Report (with key inventory + drift summary)

Before printing the final summary, run a **key inventory pass** — scan all likely locations for embedded Exa or Context7 keys, including locations this wizard does NOT manage. The user needs to see the full surface area before considering rotation.

Locations to scan (read-only; report findings; don't modify):

- `~/.claude/plugins/cc-multi-cli-plugin/config.json` — plugin's canonical copy (managed)
- `~/.codex/config.toml` (managed)
- `~/.cursor/mcp.json` (managed)
- `~/.claude/.mcp.json` — Claude Code's own MCP config (UNMANAGED — user maintains this)
- Any project-local `.mcp.json` files in commonly-used directories (cwd at minimum; report only)

(Antigravity has no wizard-managed config file, so it does not appear in this inventory.)

For each file containing an Exa or Context7 key, show: file path, which key (Exa or Context7), key fingerprint (last 6 chars), and whether it's managed by this wizard. If the same key family has different fingerprints across files, flag it as drift.

Then print the concise summary. Include the list of files that now embed the API keys — useful when the user wants to rotate a key later.

```
cc-multi-cli-plugin setup complete.

Per-CLI status:
  ✓ Codex: configured (exa, context7)
  ⚠ Cursor: skipped — not authenticated (run `agent status`)
  ⚠ Antigravity: `agy` not detected — install the agy CLI and run `agy` once to sign in (no MCP config managed by this wizard)
  ⚠ OpenCode: detected but MCP config not managed — configure Exa/Context7 via OpenCode's own wizard; run `opencode auth list` to verify auth

Drift cleaned this run:
  - Stripped stale _cc_multi_managed marker from cursor/exa, cursor/context7
  - <or report 'no drift' if none found>

Key inventory (where Exa/Context7 keys are embedded right now):
  managed by this wizard:
    ~/.claude/plugins/cc-multi-cli-plugin/config.json  exa…a3adec  ctx7…c7e8c8
    ~/.codex/config.toml                                exa…a3adec  ctx7…c7e8c8
    ~/.cursor/mcp.json                                  exa…a3adec  ctx7…c7e8c8
  not managed (review yourself):
    ~/.claude/.mcp.json                                 exa…a3adec  ctx7…c7e8c8
  drift detected: <none | list of files with mismatched fingerprints>

Backups (restore by copying .bak back — this run rotated stale ones):
  ~/.codex/config.toml.bak             (mtime: 2026-04-24 19:14 — fresh)
  ~/.codex/config.toml.bak.20260424-191100  (older snapshot, kept for reference)
  ~/.cursor/mcp.json.bak               (mtime: 2026-04-24 19:14 — fresh)

Tracking file:
  ~/.claude/plugins/cc-multi-cli-plugin/managed-servers.json
  (lists which server names this wizard adds per CLI — used by the customize skill
   and by future /multi:uninstall to know what to remove cleanly.)

Next steps:
  - Try `/codex:execute <task>`, `/cursor:delegate <task>`, `/antigravity:research <topic>`, or `/opencode:delegate <task>`.
  - Re-run `/multi:setup` anytime to reconfigure (idempotent: audits + reconciles drift, skips no-ops).
```

## Dry-run mode

If `--dry-run` was in `$ARGUMENTS`, **skip writes only — run all reads and probes.** Specifically:

- DO run: CLI detection (Step 1), plugin install state check (1.5), PATH check (1.7), auth checks (Step 2), key discovery (3a), key validation curl probes (3c — they're read-only HTTP), audit / drift detection (Step 4 substep 3), Step 5 verification probes, Step 6 key inventory scan.
- DO NOT run: any file write, any `claude plugin install`, any PATH edit, any `.bak` creation/rotation, any creation of `managed-servers.json`.

Report what WOULD be changed (or "no change") for each file. The dry-run report should give the user enough signal to decide whether to run for real.

Avoid `ls <optional-file>` or similar to test for existence — non-zero exit can torpedo parallel command batches via shell error handling. Prefer `[ -f <path> ]` or `test -f <path>` which always returns cleanly.

## Error handling

- If a config file is malformed JSON/TOML at any parse point (Step 3a discovery, Step 3.7 fast-path check, Step 4 audit), report the problem and skip that CLI — don't attempt repair. Apply this rule to every parse, not just one.
- If the user declines to provide an Exa API key, OMIT the Exa server from all configs. Context7 still gets installed across all configured CLIs. (Single canonical Exa-skip behavior — see Step 3b.)
- If the user declines to provide a Context7 key, install Context7 without an env block (free-tier limits apply at runtime).
- If a config file is read-only or locked, report the problem and skip that CLI.

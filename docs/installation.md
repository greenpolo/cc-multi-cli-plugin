# Installing Multi

## Requirements

- Node 24.12 or newer from a persistent installation. Setup records its executable path.
- Claude Code 2.1.272 or newer with function hooks. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
  would block the local gateway, so the launcher replaces it for its session with
  `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `DISABLE_BUG_COMMAND`.
- OpenAI: the official Codex CLI (`codex`) and a ChatGPT login.
- Cursor: the official Cursor SDK login. No separate Cursor CLI is required.
- OpenCode Zen: a Zen API key in OpenCode's auth store or `OPENCODE_API_KEY`.
- Antigravity: the official `agy` CLI and its native login.
- Grok: the official Grok Build CLI (`grok`) and its account login.

## Install

In Claude Code, add the marketplace and install the providers you want:

```text
/plugin marketplace add greenpolo/cc-multi-cli-plugin
/plugin install multi-openai@cc-multi-cli-plugin
/plugin install multi-cursor@cc-multi-cli-plugin
/plugin install multi-zen@cc-multi-cli-plugin
/plugin install multi-antigravity@cc-multi-cli-plugin
/plugin install multi-grok@cc-multi-cli-plugin
/reload-plugins
/multi-core:setup
```

Each provider pulls in `multi-core`. Setup writes one marked PATH block to the
applicable shell file: `~/.bashrc`, `~/.zshrc`, fish's config file, or the
PowerShell profile. It writes wrappers and shims under Multi's platform data
directory. It never shadows `claude` unless you ask for that name; `claude-multi`
starts Multi. Open a new terminal after setup.

## Customize the launch

Setup accepts two optional flags. Both persist in Multi's install state, so
re-running setup without them keeps your choices.

| Flag | Default | Effect |
| --- | --- | --- |
| `--command <name>` | `claude-multi` | Name of the launch command placed on PATH. `multi` is reserved. |
| `--models <selection>` | Curated provider defaults | External rows in `/model` and their workers: `all` for the full connected catalog, `none`, comma-separated full IDs, or `+<ids>` to add models to the saved selection. Claude's own models always stay listed. |

```text
/multi-core:setup --command multiclaude --models multi/openai/gpt-6-astra,multi/zen/kimi-k3
```

Multi starts the real Claude Code binary with gateway, model, worker, and hook
configuration. `--command` changes the wrapper name, not that configuration.
Naming the command `claude` is allowed
but shadows the plain command: every `claude` launch, including scripts, editors
and agents that call `claude -p`, starts the gateway first. Nested runs inside a
Multi session pass through to plain Claude. Setup prints a warning when you pick
that name; re-run with `--command claude-multi` to restore the default. Setting
`MULTI_MODELS` in the environment overrides the saved model selection for one
launch. Model IDs are listed in each provider's documentation.

The default picker shows four OpenAI, three Cursor, and six Zen models when those
providers are connected. A model absent from these defaults can be selected with
its full ID using `--models`; the full connected catalog remains available for
explicit selection. Use `--cursor-models` or `--zen-models` to inspect IDs. To add
one model, run `/multi-core:setup --models +multi/zen/kimi-k2.7-code`. With no
saved selection, this extends the curated defaults. Re-running setup without
`--models` preserves your selection;
existing installations with no saved selection keep the curated defaults. The
selected rows also bound Multi's registered workers. If a requested worker is
unavailable, add its model to the displayed selection and relaunch. Effort aliases for each
selected model remain available, though Claude's worker announcement lists the
model only once.

## Connect accounts

| Provider | Command | Account or credential |
| --- | --- | --- |
| OpenAI | `/multi-openai:login` | Codex's official ChatGPT login |
| Cursor | `/multi-cursor:login` | Official Cursor SDK browser login |
| OpenCode Zen | `/multi-zen:connect` | OpenCode auth or an API key |
| Antigravity | `/multi-antigravity:connect` | The official `agy` login and scoped hook |
| Grok | `/multi-grok:login` | The official Grok Build account login |

Run Zen key entry in a separate terminal. After connecting any provider, relaunch
Claude so its models and workers are discovered. `multi status` reports installed
and enabled providers; it does not authenticate accounts or run inference.

## Update

Use Claude's normal marketplace and plugin update commands. Re-running
`/multi-core:setup` refreshes the startup files and wrappers.

## Uninstall

Run `multi uninstall` before removing the plugins. It removes Multi's marked PATH
block and known wrappers while retaining provider logins. Open a new terminal,
then remove the provider and core plugins through `/plugin` if desired.

## For agents

1. Check Node, Claude Code, the shell, the platform, and the requested providers.
2. Install the selected plugins at user scope through Claude's plugin manager.
3. Ask two optional questions, offering the defaults: what to name the launch
   command (default `claude-multi`; explain that `claude` would shadow the plain
   command), and which
   external models to show in `/model` (curated defaults; full IDs are in the provider
   docs). Run `/multi-core:setup` with `--command` and `--models` as chosen and
   explain the marked PATH change.
4. Hand browser sign-in to the human. Have the human enter Zen keys in a separate
   terminal. Never accept credentials in chat or an agent tool session.
5. Run `multi status`. Ask the human to open a new terminal, launch the chosen
   command, and check `/model`.

## Run from a checkout

```sh
npm install
node plugins/multi-core/src/launcher.ts
MULTI_ANTIGRAVITY=1 node plugins/multi-core/src/launcher.ts
node plugins/multi-core/src/launcher.ts --antigravity-setup
```

The launcher loads the checkout's `multi-core` plugin itself when the plugins
are not installed, so the Claude Mods hooks work immediately from a checkout.
You can still install the plugins from the checkout with `/plugin marketplace add
/path/to/checkout` followed by the plugin installs above. Antigravity is enabled
by installing `multi-antigravity`. From a checkout, set `MULTI_ANTIGRAVITY=1` to
show its models and workers. Run `--antigravity-setup` after the official `agy`
login to install its scoped permission hook.

Whole-session `--bg`, `--background`, `attach`, and `respawn` are currently
unsupported: the gateway and generated settings belong to the launcher process.
Use `--resume <session-id>` for a fresh launch. Ordinary background subagent tasks
within an attached session remain supported.

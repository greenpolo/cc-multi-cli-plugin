# Installing Multi

## Requirements

- Node 24.12 or newer from a persistent installation. Setup records its executable path.
- Claude Code 2.1.272 or newer with function hooks. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
  would block the local gateway, so the launcher replaces it for its session with
  `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_BUG_COMMAND` and
  `DISABLE_FEEDBACK_COMMAND`.
- A proxy (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`) and a caller-set `ANTHROPIC_BASE_URL` are
  honored for Claude's own traffic: the gateway forwards it through the proxy to that base URL.
  Node reads the proxy variables at startup only, so the installed command starts the launcher
  with `NODE_USE_ENV_PROXY=1`; a launcher started by hand needs it set.
- Remote Control works in a session signed in to claude.ai. There the gateway is Claude Code's
  local HTTPS proxy instead of its base URL, and Claude Code trusts a certificate made for that
  session only. Your own `HTTPS_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS` still apply, and the
  commands Claude runs see them unchanged. With an API key, another provider, your own
  `ANTHROPIC_BASE_URL`, or `MULTI_GATEWAY_TRANSPORT=base-url`, the gateway is the base URL and
  Claude Code turns Remote Control off.
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

By default the picker shows all six OpenAI models, three Cursor rows, five Zen
models, and the models `agy` and `grok` advertise. To add one model to that, run
`/multi-core:setup --models +multi/zen/glm-5.2`; `--cursor-models`, `--zen-models`,
`--antigravity-models` and `--grok-models` print the IDs.

Each connected provider gets exactly one Agent-tool worker type (`OpenAI`,
`Zen`, `Cursor`, `Antigravity`, `Grok`), and a type's
models are exactly its provider's rows in this selection: the Agent tool's
`model` parameter names one of them, as a short id (`kimi-k3`) or the full
`multi/zen/kimi-k3` id. A model absent from the selection is refused when a
worker requests it; add it to `--models` and relaunch to make it selectable.

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

## Claude desktop app

Setup also prepares the Claude desktop app's Code tab, which runs no launcher: there
Multi's mod starts the gateway with each new session, so `/model` rows and workers work
as in `claude-multi`. Workers show as `multi-core:OpenAI` and so on, because Claude Code
names agents a plugin registers after the plugin. Start a new desktop session after setup.

Setup writes two entries to `~/.claude/settings.json`, and `multi uninstall` restores both:

- `modelPicker`: the connected providers' `/model` rows. Plain `claude` in a terminal
  lists them too; they answer only in a `claude-multi` or desktop session.
- `env.NODE_EXTRA_CA_CERTS`: your own extra certificates (if any) plus one Multi makes
  for this installation (valid 397 days, renewed by setup; its key stays in Multi's data
  directory, readable only by you). It lets a desktop session reach the gateway as its
  proxy and keep Remote Control. Without it the session uses `ANTHROPIC_BASE_URL`, with
  Remote Control off and a one-line notice. Re-run setup if you change your own
  `NODE_EXTRA_CA_CERTS`.

## Update

Use Claude's normal marketplace and plugin update commands. Re-running
`/multi-core:setup` refreshes the startup files and wrappers.

## Uninstall

Run `multi uninstall` before removing the plugins. It removes Multi's marked PATH
block and known wrappers, and restores the `modelPicker` and `env.NODE_EXTRA_CA_CERTS`
entries setup wrote in Claude's user settings, while retaining provider logins. Open a new terminal,
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
show its models and workers. The launcher installs and repairs its scoped permission
hook itself; `--antigravity-setup` does the same by hand.

Whole-session `--bg`, `--background`, `attach`, and `respawn` are currently
unsupported: the gateway and generated settings belong to the launcher process.
Use `--resume <session-id>` for a fresh launch. Ordinary background subagent tasks
within an attached session remain supported.

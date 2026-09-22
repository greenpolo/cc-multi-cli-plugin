# Privacy

The plugin runs its gateway on your machine. Multi has no hosted service and
sends no telemetry to the plugin author. It tracks local usage and lifecycle
information for its dashboard, optional traces, and receipts.
Claude Code, provider CLIs, SDKs, and native tools have
their own data handling and privacy policies.

## What is sent where

| Provider | Endpoint or runtime | Data sent |
| --- | --- | --- |
| Anthropic | `https://api.anthropic.com` through Claude's configured connection | Claude Messages requests, conversation context, tools, and attachments. |
| OpenAI | Codex app-server and `https://chatgpt.com/backend-api/codex` | Selected conversation, instructions, tools, and attachments; Codex handles authentication and review. |
| Zen | `https://opencode.ai/zen/v1/` | Selected conversation, instructions, tools, and attachments. |
| Cursor | Official Cursor SDK | Selected conversation, workspace context, tools, and tool results through the SDK's native run. |
| Antigravity | Official `agy` CLI | Selected conversation, workspace context, tools, and tool results through the CLI's native run. |
| Grok | Official Grok Build CLI | Selected conversation, workspace context, tools, and tool results through the CLI's native run. |

Native tools can read workspace files, run commands, and contact services allowed
by the effective provider and Claude permissions. Inference follows the selected
provider route; automatic review follows the originating provider's review path.
Opening the usage pane or enabling quota advice can also query other enabled
providers' account interfaces without inference. These account lookups do not send
the conversation to those providers. Provider retention and billing follow the
provider's policies.

## What is stored locally

| Item | Path |
| --- | --- |
| Codex authentication | Codex's `auth.json`: `$CODEX_HOME/auth.json`, or `~/.codex/auth.json`. |
| Cursor SDK authentication and state | Cursor-owned files, including `~/.cursor/sdk/auth.json`; Multi run state is `~/.cursor/multi-harness/` on Unix and `$LOCALAPPDATA/.cursor/multi-harness/` on Windows. |
| Zen authentication | `$OPENCODE_AUTH_FILE`, or `$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share/opencode/auth.json`) on Unix and `%LOCALAPPDATA%/opencode/auth.json` on Windows. |
| Antigravity hook and settings | `~/.gemini/config/hooks.json` and `~/.gemini/antigravity-cli/settings.json` on Unix; `%LOCALAPPDATA%/gemini/config/hooks.json` and `%LOCALAPPDATA%/gemini/antigravity-cli/settings.json` on Windows. |
| Antigravity run state | The `multi-harness` directory beside Antigravity's settings file. It contains session and response records for continuation and recovery. |
| Grok run state | The `multi-harness` directory under `~/.grok`. It contains session and response records for continuation and recovery. Grok's own sessions stay in `~/.grok/sessions`. |
| Multi installation state | `~/.local/share/multi-cli/`, including `state.json`, wrappers, and runtime files. |
| Temporary launcher settings | A `multi-native-settings-*` directory under the platform temporary directory. It is removed on normal shutdown. |
| Optional trace output | `MULTI_NATIVE_TRACE=1` enables routing, model, status, and tool-name diagnostics on stderr, without prompt bodies or credentials. Redirect stderr explicitly to save them. |
| Optional receipts | The file selected by `MULTI_RECEIPTS_FILE`, containing session/worker identifiers, timing, outcomes, model and usage totals, without prompts, responses, tool arguments, or credentials. |

Run state and responses can contain task content, workspace paths, and tool-output
previews. Provider CLIs and SDKs can store their own transcripts, logs, credentials,
and execution state in provider-controlled locations.

## What is never done

- Multi never creates a Claude token pool or forwards Claude credentials to another provider.
- Antigravity and Grok CLIs authenticate their own inference. Grok's usage reader loads its native auth file to check key/refresh-token presence and access-token expiry; it does not forward those credentials or return them in usage data. Multi stores no provider credentials in its installation directory and removes `XAI_API_KEY` from Grok runs to select account login.
- Multi never sends telemetry to the plugin author.
- Multi never runs a separate reviewer for Zen, Antigravity, or Grok.

## Removing data

Stop Claude and active provider runs first, then run `multi uninstall`.

This removes Multi startup files and its installation state, not provider run
records. To remove Multi run records, remove the Cursor, Antigravity, and Grok
`multi-harness` directories listed above. Optional receipt files and redirected
trace logs must be removed separately. Remove temporary `multi-native-settings-*`
directories left by interrupted runs. Use each provider's own commands and account controls to
remove provider credentials, transcripts, and logs.

Source: <https://github.com/greenpolo/cc-multi-cli-plugin>.
Report concerns through <https://github.com/greenpolo/cc-multi-cli-plugin/issues>.

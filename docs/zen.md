# OpenCode Zen

OpenCode Zen models use direct API requests while Claude Code owns tools, permissions, and history.

## Setup

1. Install the core and Zen plugins. See [docs/installation.md](installation.md).
2. Run `/multi-zen:connect`.
3. Open a separate terminal and run the connection command shown by the skill;
   the helper prompts for the key there without echoing it.
4. Relaunch the session so Zen models and workers load.

Zen uses an API key stored in OpenCode's auth store. The writer requests mode
`0600` on POSIX; Windows access is governed by filesystem ACLs.

| Platform | Default auth file |
| --- | --- |
| Linux and macOS | `$XDG_DATA_HOME/opencode/auth.json`, or `~/.local/share/opencode/auth.json` |
| Windows | `%LOCALAPPDATA%\opencode\auth.json` |
| Any platform with an override | The path in `OPENCODE_AUTH_FILE` |

`OPENCODE_API_KEY` can provide the key for a process. The connection helper preserves other provider entries in the OpenCode auth store.

## Models

Use `/model multi/zen/<model-id>`. The default picker includes DeepSeek V4 Pro,
DeepSeek V4 Flash, Kimi K3, GLM 5.3, GLM 5.3 Flash, and Muse Spark 1.3. The table
below lists the full supported catalog; other rows require explicit selection.

| Model IDs | Protocol | Effort |
| --- | --- | --- |
| `deepseek-v4-pro`, `deepseek-v4-flash`, `kimi-k3`, `glm-5.3`, `glm-5.3-flash`, `kimi-k2.7-code`, `glm-5.2`, `minimax-m2.7`, `big-pickle`, `mimo-v2.5-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`, and `nemotron-3.5-lightning-free` | Chat Completions | Provider-native reasoning |
| `gpt-6-luna`, `gpt-6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `muse-spark-1.3`, `muse-spark-1.3-contributor-free`, `muse-spark-1.2-contributor-free` | Responses | `low`, `medium`, `high`, `xhigh`, and `max` for GPT and `muse-spark-1.3`; `low`, `medium`, `high`, and `xhigh` for contributor-free Muse |

Workers use the `zen-<model-id>` name. Models with effort support also have effort-suffixed workers. Chat workers have no effort variants.

## Execution

Claude Code executes tools and applies its permission mode. Zen has no independent model-based reviewer. Claude-backed classification remains available when Claude access is present. Zen never borrows OpenAI reviewer capability.

## Caching and continuation

Stable translated instructions, tool ordering, and history preserve reusable prefixes. The gateway keeps a cache identity across restarts for the Claude session, worker, model, and workspace, and sends it as `x-opencode-session` and, for Responses, `prompt_cache_key`. Cache reads, writes, and fresh input are reported separately by upstream usage.

Visible conversation history transfers when switching models. Zen reasoning signatures stay with their Zen model. Compaction or a model switch can make the next request cold. Cancellation or an interrupted stream can leave final usage unavailable.

## Limits

The gateway rejects unknown models, unsupported effort values, unsupported media, and output limits above the model catalog limit. Chat routes are text-only except for models whose catalog entry accepts images. Chat routes do not accept PDF input. Token counts are estimates, and Zen requests have no implicit gateway deadline.

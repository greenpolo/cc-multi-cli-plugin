# Antigravity

Run the official `agy` CLI as a native coding worker inside Claude Code.

## Setup

Install the plugin as described in [docs/installation.md](installation.md). Sign
in with the official `agy` account flow, then connect it to Claude Code:

```text
/multi-antigravity:connect
```

The connection command installs the scoped global `PreToolUse` hook. From a
checkout, the equivalent setup is:

```sh
node plugins/multi-core/src/launcher.ts --antigravity-setup
MULTI_ANTIGRAVITY=1 node plugins/multi-core/src/launcher.ts
```

`--antigravity-models` lists the catalog. The gateway uses `agy` authentication
and does not read provider tokens or call Antigravity model endpoints.

## Models

The picker reads the models advertised by `agy`.

| Picker entry | Route | Named worker |
| --- | --- | --- |
| Advertised base family | `multi/antigravity/<base>` | `antigravity-<base>` |
| Advertised `-low`, `-medium`, or `-high` variant | `multi/antigravity/<id>` | `antigravity-<id>` |
| Unsuffixed advertised model | `multi/antigravity/<id>` | `antigravity-<id>` |

Suffix variants group behind a base row when no independent base model exists.
The default variant order is medium, high, then low. `/effort` accepts only an
advertised low, medium, or high variant. Unknown models and unavailable effort
variants fail explicitly.

### Context window

Gemini rows and their workers carry a `[1m]` tag on the model ID, so Claude sizes
the session to the million input tokens Gemini 3.x accepts. The tag is Claude-side
display metadata: `agy` never sees it, both spellings select the same native model,
and `/effort` still offers only the advertised low, medium, and high variants.

Other advertised models keep Claude's 200K default, because their window is smaller
or unestablished: GPT-OSS 120B accepts 131,072 tokens, and the Claude models served
here carry no 1M entitlement. `agy models` reports no capacity metadata, so the
eligible families are listed in `launcher.ts` rather than discovered. Set
`MULTI_DISABLE_1M_CONTEXT=1` to leave every row untagged.

Claude's window governs when the session compacts. It is separate from the native
`agy` conversation, which keeps its own state and its own limits.

## Execution and permissions

Claude's permission mode and tool rules take precedence. `agy` runs with native
permissions skipped. The namespaced global hook reads `MULTI_ANTIGRAVITY_DENY`
and denies Claude-excluded native tools. Native children and MCP tools are always
denied. External actions appear as display text and are never replayed as
executable Claude tools. Claude and OpenAI parents can spawn named Antigravity
workers.

Every run selects its native workspace explicitly with `--add-dir`; subprocess
cwd alone does not select it. Auto, acceptEdits, and Bypass use the native CLI
without a reviewer, while the hook enforces explicit Claude restrictions. Plan
also passes `--mode plan` and denies shell, write, edit, notebook-edit, and
delegation tools. Unsupported modes, tool restrictions, and policy controls fail
explicitly.

The hook command uses a POSIX shell guard on Linux, macOS, and other Unix hosts.
Windows invokes Node directly because a shell is not assumed. Native config does
not grant permission to a run.

## Continuation, caching and failures

State is isolated by Claude session, worker, provider, and canonical workspace.
The gateway persists the native conversation ID and sends only the newest turn
after the last assistant message. Outer history changes produce a notice and
continue on the native conversation; native state is never rewound.

Completed identical requests can replay saved output. CLI usage is cumulative,
so resumed usage is differenced from the previous recorded total. Cache reuse is
best-effort. An uncertain run is never replayed. If a run reports a conversation
ID but no terminal result, the next request streams an interruption notice before
continuing. Non-success terminal results are reported as errors and are retried
by a later identical request.

One turn runs at a time per worker and workspace. An identical in-flight request
observes the existing exchange. A different request for that busy identity is
refused with a deterministic error rather than queued behind it:
resuming a prompt whose history stops at the previous assistant message would
forward the running turn to the CLI a second time. Multi never reruns a paid
turn on a guess; send the prompt again once the answer lands. Cursor and Grok
refuse the same way.

## Config and hook paths per OS

| OS | Global hook file | Settings file |
| --- | --- | --- |
| Linux and macOS | `~/.gemini/config/hooks.json` | `~/.gemini/antigravity-cli/settings.json` |
| Windows | `%LOCALAPPDATA%\gemini\config\hooks.json` (or `%APPDATA%`) | `%LOCALAPPDATA%\gemini\antigravity-cli\settings.json` (or `%APPDATA%`) |

The installed hook is named `multi-cli-antigravity`. Setup preserves other hook
entries. Run setup again after moving the checkout or changing the Node install.

## Limits

The CLI accepts text and native automatic tools. Images, documents, forced tool
choices, strict output schemas, and stop sequences are unsupported. Native
compaction is owned by `agy`; Claude compaction summaries run with all mapped
native tools denied and preserve native history. Native counters and local prompt
estimates are reported separately.

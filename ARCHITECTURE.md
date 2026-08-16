# Architecture

How the pieces fit together. Pair this with `AGENTS.md` (conventions) and
`plugins/multi/scripts/lib/adapters/CONTRACT.md` (the adapter interface).

## Request lifecycle

```
User: /codex:review
  │
  ▼
plugins/codex/commands/review.md            slash command — no subagent; the main
  │  loop runs one `Bash(node:*)` call (optionally `run_in_background`) and returns
  │  the companion's stdout verbatim. Write/investigate commands still go through a
  │  framing forwarder in plugins/multi/agents/ instead.
  ▼
multi-cli-companion.mjs review --cli codex --cwd <dir>   CLI entrypoint + dispatcher
  │  parses args, resolves workspace, selects adapter from the registry
  ▼
lib/adapters/codex.mjs (adapter.invoke)      adapter speaks the CLI's native protocol
  │
  ▼
app-server broker  ──►  codex app-server  ──►  Codex model
```

The same chain holds for `cursor` (headless `agent -p`), `antigravity` (headless
`agy -p`), and `opencode` (headless `opencode run --format json`), just with a
different adapter and transport.

## Companion subcommands

`multi-cli-companion.mjs <subcommand> [--cli <name>] [--cwd <dir>] ...`

| Subcommand | Purpose |
|---|---|
| `task` | Run a prompt (the workhorse). Flags: `--background`, `--write`, `--resume-last`/`--fresh`, `--until-done`, `--model`, `--effort`. |
| `review` / `adversarial-review` | Read-only code review over a diff. Flags: `--wait`/`--background`, `--base`, `--scope`. |
| `status` / `result` / `cancel` | Inspect / fetch / stop background jobs. |
| `setup` | Toggle the stop-review gate and other config. |

Global: `--cli <codex|cursor|antigravity|opencode>` (default `codex`), `--cwd`/`-C <dir>`.

## Adapter registry

`multi-cli-companion.mjs` imports the four adapter modules and registers them by
name (`{ codex, cursor, antigravity, opencode }`). `getAdapter(name)` throws a clear
error for unknown names. Each module exports an `adapter` object — see `CONTRACT.md`.
Adding a CLI = add a conforming adapter module + register it in `registry.mjs`; the
conformance test (`test/unit/adapter-contract.test.mjs`) enforces the shape.

## Job & state model

- **State is keyed by working directory (`cwd`).** Always pass `--cwd`. Jobs and
  broker sessions for one workspace are isolated from another's.
- Background `task`/`review` runs are recorded as jobs (`lib/job-control.mjs`);
  `status`/`result`/`cancel` operate on those job ids.
- Jobs are also tagged with the Claude `sessionId`, so the session-lifecycle hook
  can clean up a session's job entries on exit.
- Parallel agents: give each its own worktree/cwd so job and broker state don't
  cross-contaminate.

## Broker lifecycle (and the current leak)

Codex talks the App Server Protocol over a **persistent broker daemon** so each
`task` doesn't pay app-server cold-start:

- `lib/broker-lifecycle.mjs` → `ensureBrokerSession(cwd)` reuses a live broker for
  that cwd, or spawns one (`spawnBrokerProcess`, `detached: true` + `unref()`).
- A broker self-terminates on `broker/shutdown` (RPC), `SIGTERM`, `SIGINT`, or
  after an **idle window** (`CODEX_COMPANION_BROKER_IDLE_MS`, default 600000 ms;
  set `0` to disable) — see `app-server-broker.mjs` + `shouldIdleShutdown`.
- `teardownBrokerSession(...)` kills the process and cleans the pid/log/socket and
  session dir. It is invoked only when replacing a *stale* broker on the next call
  to the same cwd.

**Reaping (the former leak, now fixed):** the SessionEnd hook
(`session-lifecycle-hook.mjs`) calls `sendBrokerShutdown` + `teardownBrokerSession`
for the session's *primary* cwd. But brokers spawned for any *other* cwd (extra or
transient workspaces) are never seen by that hook, and previously had no idle
self-shutdown — so they lingered until reboot, pinning their cwd dir open on
Windows. The backstop is now an **idle timer** in `app-server-broker.mjs`: a broker
with no in-flight turn and no activity for `CODEX_COMPANION_BROKER_IDLE_MS`
(default 600000 ms) shuts itself down. The decision is the pure
`shouldIdleShutdown` (`lib/broker-lifecycle.mjs`), unit-tested in
`test/unit/broker-lifecycle.test.mjs`.

## Transports at a glance

- **Codex** — App Server Protocol via the broker daemon (`lib/app-server.mjs`).
- **Cursor** — headless print mode (`lib/adapters/cursor.mjs`), spawning `agent -p`
  with the prompt on stdin and parsing `json`/`stream-json` output. On Windows,
  Cursor's shell tool is slow/unreliable (host-PATH/WSL), so `/cursor:delegate`
  defers build/test verification to the caller.
- **Antigravity** — headless `agy -p` (`lib/adapters/antigravity.mjs`). `agy`'s
  headless stdout is empty upstream (google-antigravity/antigravity-cli#318; `--output-format stream-json` on agy >=1.1.8 is the coming workaround), so the adapter learns the
  conversation id from a per-invocation `--log-file` and recovers the answer from
  the on-disk transcript JSONL. Read-only research/explore only (EXPERIMENTAL).
- **OpenCode** — headless `opencode run --format json` (`lib/adapters/opencode.mjs`),
  spawning the npm `opencode.cmd` shim with the prompt on stdin and parsing the
  NDJSON event stream (one JSON object per line). Read-only roles (`research`,
  `explore`) run via injected oc-* primary agents with write/edit/bash denied
  (OpenCode has no `--read-only` flag). Write roles use `--dangerously-skip-permissions`.
  `--until-done` is supported; `--effort` is not. Default model: `opencode/claude-opus-5`
  (Zen — billed separately). **Token-offload caveat:** `anthropic/*` models reuse the
  Claude Code subscription and provide zero offload; real offload requires `opencode/*`,
  `openai/*`, `google/*`, `github-copilot/*`, or `ollama/*` models.

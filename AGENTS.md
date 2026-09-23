# Contributor guide

## Orientation

Read [ARCHITECTURE.md](ARCHITECTURE.md) and [README.md](README.md) first. Setup
and provider details live in [docs/installation.md](docs/installation.md),
[docs/openai.md](docs/openai.md), [docs/cursor.md](docs/cursor.md),
[docs/zen.md](docs/zen.md), [docs/antigravity.md](docs/antigravity.md), [docs/grok.md](docs/grok.md),
[docs/permissions.md](docs/permissions.md), and [docs/platform-support.md](docs/platform-support.md).
Claude Code function-hook UI and extensibility rules live in
[docs/claude-mods.md](docs/claude-mods.md).
`.agent/` is gitignored scratch space. It is never authoritative.

## Code map

| Path | Responsibility |
| --- | --- |
| `plugins/multi-core/src/launcher.ts` | Launches the gateway and registers models and workers. |
| `plugins/multi-core/src/gateway/server.ts` | Routes requests and manages sessions. |
| `plugins/multi-core/src/gateway/messages.ts`, `fetch.ts`, `tools.ts` | Shared protocol, outbound fetch, and tool aliases. |
| `plugins/multi-core/src/gateway/executable.ts`, `process-tree.ts` | Resolves executables and manages child processes. |
| `plugins/multi-core/src/gateway/atomic-write.ts`, `state-lock.ts` | Protects files and serializes native state. |
| `plugins/multi-core/src/gateway/cursor-settings.ts`, `mode-hook.ts`, `agent-definitions.ts`, `worker-catalog.ts` | Admits settings, maps prompt and worker permissions, and resolves the Agent tool's `model` against each provider's worker catalog. |
| `plugins/multi-core/src/gateway/approval.ts`, `permission-hook.ts` | Approval protocol and capability checks. |
| `plugins/multi-core/src/gateway/mod-*.ts`, `display-rows.ts`, `tool-observer.ts` | Claude Mods control-plane routes, compaction, policy, native action display rows, and tool observation. |
| `plugins/multi-core/src/gateway/harness-*.ts` | Session store, exchange registry, response builder, completion, and notices shared by Cursor, Antigravity, and Grok; CLI process runner and text prompt preparation shared by Antigravity and Grok. |
| `plugins/multi-core/src/account.ts`, `setup.ts`, `install/` | Accounts, bootstrap, plugin discovery, and installation. |
| `plugins/multi-openai/src/` | Codex authentication, models, Responses translation, instructions, and reviewer. |
| `plugins/multi-cursor/src/` | Cursor SDK harness, permissions, progress, requests, models, and workspaces. |
| `plugins/multi-zen/src/` | Zen API-key authentication, catalogs, requests, and translations. |
| `plugins/multi-antigravity/src/` | `agy` CLI harness, models, hooks, requests, and permissions. |
| `plugins/multi-grok/src/` | Grok Build CLI harness, models, requests, permissions, and login state. |
| `test/unit/` | Offline unit tests for gateway and provider behavior. |
| `test/live/` | Opt-in checks against native CLIs and provider services. |
| `scripts/` | Development utilities, including banner generation. |
| `.github/workflows/ci.yml` | Runs `npm run check` on Node 24 across Linux, macOS, and Windows. |
| `package.json`, `biome.json`, `knip.json` | Scripts, lint rules, and entry/project analysis. |

Keep provider authentication and catalogs in provider folders. Keep shared protocol
types and cross-provider helpers in `plugins/multi-core/src/gateway/`. Prefer
direct module imports, the existing repository convention. Platform-dependent code
accepts an explicit `platform` option so every branch is unit-testable on Linux.

## Current execution contracts

These describe the implemented provider boundaries to preserve during ordinary
changes. Provider limitations are not permanent bans on requested new features;
changes to those boundaries need corresponding implementation and verification.

- Claude's permission mode controls every provider at prompt boundaries.
- Each provider owns its login, reviewer, execution state, and credentials.
- Fail explicitly on unsupported modes, unknown workers, ambiguous ownership, or missing review.
- Never replay external tool events as executable Claude tools.
- Native state is never rewound, and uncertain actions are never rerun blindly.
- Antigravity native children and MCP are denied. Grok denies native subagents and MCP execution, and verifies the toolset the CLI announces.
- New bridges isolate session, worker, provider, and workspace state.
- Do not use Cursor Fast in development or live tests; set `fast:false` explicitly.
- Keep paid probes bounded and reuse existing usage records when possible.

## Claude Code extensibility requirement

Use Claude Mods function hooks for Claude Code harness UI or extensibility changes,
as explicitly requested by the maintainer. Read [docs/claude-mods.md](docs/claude-mods.md)
before changing that surface. Reuse the authenticated `/multi/mod/*` control plane
when gateway data or actions are needed; local rendering changes need no new route.

## Verification

Run `npm run check`. It checks the generated banner, Biome lint, Knip, strict
type checking, and offline tests. `npm test` runs `tsc --noEmit` and the unit
test suite. Use Node 24.12 or newer and avoid `DEP0190` warnings.

For Claude Mods hook or surface changes, also run `npm run test:mod`. It type-checks
the hooks against `.claude/types` (write them with `/plugin-types` first; they are
gitignored) and runs `claude plugin test` with the installed Claude executable,
without provider inference. It is separate from `npm run check` and the current CI matrix.

| Command | Check | Login needed |
| --- | --- | --- |
| `npm run test:live:compaction` | Claude/OpenAI compaction and resume | Claude and Codex login |
| `npm run test:live:zen` | Zen tools, cache, and resume | Zen API key |
| `npm run test:live:cursor` | Cursor SDK tools, continuation, and disk resume | Cursor SDK login |
| `npm run test:live:openai-instructions` | Requested planning/delegation and Plan restrictions (three-request budget) | Codex login |
| `npm run test:live:auto-mode` | Native Auto mode | Provider login under test |
| `npm run test:live:provider-approval` | Provider approval | Provider login under test |
| `npm run test:live:reviewer` | OpenAI reviewer allow/deny and inspection | Codex login |
| `npm run test:live:approval-worker` | Worker approval | Provider login under test |
| `npm run test:live:permissions` | Native permissions | Claude and provider login |
| `npm run test:live:antigravity` | Antigravity CLI harness | `agy` login |
| `npm run test:live:grok` | Grok Build CLI harness | Grok Build login |
| `npm run test:live:install` | Plugin installation | None |

The definition of done is passing relevant checks, no `DEP0190` warnings, and an
updated `CHANGELOG.md` for user-facing changes.

## Code style

Biome requires braces, one variable declaration per statement, no nested ternaries,
no parameter reassignment, no explicit `any`, no non-null assertions, and cognitive
complexity of 15 or less. Do not disable rules, add blanket suppressions, or raise
limits. Explain any narrow suppression beside the constrained code. Use clear
state ownership and keep protocol constraints explicit.

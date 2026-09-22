# Platform support

The [CI workflow](../.github/workflows/ci.yml) is configured to run offline checks
on Linux, macOS, and Windows for pushes and pull requests. A configured matrix is
not evidence that a particular revision passed; consult that revision's workflow
results. Live provider checks need a real login on the host and are run by hand.

## Verification scope (documentation audit: September 22, 2026)

| Provider | Earlier Linux live reports | Earlier Windows live reports | macOS live evidence |
| --- | --- | --- | --- |
| OpenAI | Inference, reviewer, manual/repeated compaction and resume; automatic compaction still pending | Reviewer and approval-worker checks; broader mode/compaction reruns pending | No recorded run in this guide |
| Cursor SDK | Tools, continuation and disk resume | Native harness check | No recorded run in this guide |
| OpenCode Zen | Tools/cache/resume, including revalidation of saved traces | Live rerun pending | No recorded run in this guide |
| Antigravity | Native harness check | Native harness check from an interactive desktop login | No recorded run in this guide |
| Grok | No recorded live run in this guide | Native harness reported; exact test/version evidence not recorded here | No recorded run in this guide |

These are historical reports carried forward from this guide and the
[changelog](../CHANGELOG.md), not a certification of the current refactor.
Original run dates and complete logs were not recorded here. WSL uses Linux
policy and config paths; WSL2 remains untested, with no recorded offline or live
run on a WSL2 host. Its verification is tracked in
[issue #21](https://github.com/greenpolo/cc-multi-cli-plugin/issues/21).
Future verification reports should name the tested revision, date, OS, CLI/SDK
versions, command and result, including skips and a log reference when available.

The earlier Windows report used Windows 11, PowerShell 7, Node 24, Claude Code
2.1.273: the unit suite, live install, Cursor, OpenAI reviewer, OpenAI
approval worker and Antigravity checks passed. The permissions check skipped its
PTY cases, and the provider-approval check skips its dialog proof; its direct
non-PTY path still needs its expectations adapted. The previously reported Zen, auto-mode and compaction failures also reproduced
on Linux. The fixes cover Zen terminal reasoning reconciliation, native Auto
policy propagation, and compaction before the first restored prompt. Linux
validation now covers manual/repeated compaction and fresh-process resume. Saved
live Zen traces pass the corrected tool, usage, resume, and cache assertions;
saved OpenAI worker Auto traces pass the corrected allow/deny and handback checks.
The automatic compaction case and Windows live reruns were still pending in that
report; those Linux results do not establish a Windows pass.

The September 22 shared-harness refactor was checked on Linux with offline unit
tests (including injected Linux/macOS/Windows branches) and local Claude Mods
tests. No paid provider probes or native macOS/Windows runs were performed for
that refactor. Injected platform tests do not replace execution on those hosts.

## Live checklist

Run from a fresh checkout after `npm ci`.

| Command | Coverage | Required setup |
| --- | --- | --- |
| `npm run test:live:compaction` | Claude/OpenAI compaction, edits, and resume | Claude and Codex login |
| `npm run test:live:zen` | Zen tools, cache usage, and resume | `OPENCODE_API_KEY` or OpenCode `/connect` |
| `npm run test:live:cursor` | Cursor tools, continuation, disk resume, non-Fast execution | Cursor SDK login and `--cursor-login` |
| `npm run test:live:auto-mode` | OpenAI Auto review and routing | Claude and Codex login |
| `npm run test:live:provider-approval -- --launcher` | Provider review and Claude terminal approval | Codex, Claude, Python 3 on POSIX |
| `npm run test:live:reviewer` | OpenAI review allow/deny behavior | Codex login |
| `npm run test:live:approval-worker` | OpenAI worker permissions | Codex login and Claude launcher |
| `npm run test:live:permissions` | Modes, denials, effects, and attribution | Provider login, Python 3, Node 24 |
| `npm run test:live:antigravity` | `agy` tools, continuation, and saved resume | `agy` login, `--antigravity-setup`, advertised model |
| `npm run test:live:grok` | Grok tools, denial, continuation, and saved resume | Grok Build login and an advertised model |
| `npm run test:live:install` | Plugin install, startup, wrappers, and uninstall | Claude executable |

On Windows, PTY checks require ConPTY and skip with an explicit message. The
remaining checks run from PowerShell or cmd when Node, Claude, Codex, `agy`, and
the provider tools resolve through `PATH` and `PATHEXT`. The `agy` login is
visible only to interactive logon sessions on Windows: a check started over SSH
reports "not logged in" even when the desktop session is signed in. Run the
Antigravity check from the desktop session, or through a scheduled task
registered with the interactive logon type.

## Fresh-host procedures

### macOS

1. Install Node 24.12+, Claude Code, and the Codex, `agy`, or Grok Build CLIs as needed. `npm ci` installs the Cursor SDK; Zen needs an API key, not the OpenCode executable. Sign in to the providers you will test.
2. Run:

   ```sh
   npm ci
   npm run check
   node plugins/multi-core/src/launcher.ts --cursor-login
   node plugins/multi-core/src/launcher.ts --cursor-models
   npm run test:live:install
   npm run test:live:cursor
   npm run test:live:zen
   npm run test:live:compaction
   npm run test:live:auto-mode
   npm run test:live:provider-approval -- --launcher
   npm run test:live:reviewer
   npm run test:live:approval-worker
   npm run test:live:permissions
   node plugins/multi-core/src/launcher.ts --antigravity-setup
   npm run test:live:antigravity
   npm run test:live:grok
   ```

### Windows native

1. Install Node 24.12+, Claude Code, PowerShell or cmd, and the Codex, `agy`, or Grok Build CLIs as needed. `npm ci` installs the Cursor SDK; Zen needs an API key, not the OpenCode executable. Sign in to the providers you will test.
2. In PowerShell or cmd, run the same commands listed for macOS. Use `npm.cmd` when the shell requires it.

Managed Claude policy comes from `/etc/claude-code` on Linux and WSL,
`/Library/Application Support/ClaudeCode` and macOS preferences on macOS, and
`C:\Program Files\ClaudeCode` and the Windows policy keys on Windows. Windows
policy keys are read with `reg query`; when `reg.exe` reports a localized
failure, Windows PowerShell classifies the key as absent or failed. macOS
preferences are read with `defaults read`; a missing domain is recognized from
both wordings `defaults` uses for it, `does not exist` and the macOS 27
`Domain '...' not found`.

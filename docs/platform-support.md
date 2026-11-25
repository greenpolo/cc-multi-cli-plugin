# Platform support

The [CI workflow](../.github/workflows/ci.yml) runs `npm run check` (lint, unused-code
and type checks) on Linux, macOS, and Windows for pushes and pull requests. Live
provider checks need a real login on the host and are run by hand.

## Live checks

The live checks and the logins each needs are listed in
[AGENTS.md](../AGENTS.md#verification). Run them from a fresh checkout after `npm ci`.
WSL uses Linux policy and config paths and has no recorded run; see
[issue #21](https://github.com/greenpolo/cc-multi-cli-plugin/issues/21).

On Windows, PTY checks require ConPTY and skip with an explicit message. The
remaining checks run from PowerShell or cmd when Node, Claude, Codex, `agy`, and
the provider tools resolve through `PATH` and `PATHEXT`. The `agy` login is
visible only to interactive logon sessions on Windows: a check started over SSH
reports "not logged in" even when the desktop session is signed in. Run the
Antigravity check from the desktop session, or through a scheduled task
registered with the interactive logon type.

## Platform notes

A native CLI that resolves to a `.cmd` or `.bat` file that is not a standard npm
shim is started through `cmd.exe`, which expands `%VAR%` and has no safe escape
for quotes. Such a launcher is refused any argument containing `"`, `%`, `!`,
`^`, `&`, `|`, `<`, `>` or a line break; providers send prompt text on stdin
instead (`promptArgvSafe`). Cancelling a Windows run first asks the process tree
to close (`taskkill /T`) and forces it (`/F`) only after the grace period, and
nothing is killed by PID after the child has exited.

Managed Claude policy comes from `/etc/claude-code` on Linux and WSL,
`/Library/Application Support/ClaudeCode` and macOS preferences on macOS, and
`C:\Program Files\ClaudeCode` and the Windows policy keys on Windows. Windows
policy keys are read with `reg query` (run from `System32` with a 10 s timeout, as are `powershell.exe` and `/usr/bin/defaults`); when `reg.exe` reports a localized
failure, Windows PowerShell classifies the key as absent or failed. macOS
preferences are read with `defaults read`; a missing domain is recognized from
both wordings `defaults` uses for it, `does not exist` and the macOS 27
`Domain '...' not found`.

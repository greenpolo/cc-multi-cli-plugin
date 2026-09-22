---
name: login
description: Sign in to Grok Build for the native harness.
disable-model-invocation: true
allowed-tools: Bash
---

Tell the user to run the official Grok Build sign-in in their own terminal:

Linux/macOS (POSIX shell):

```sh
"$HOME/.local/share/multi-cli/bin/multi" login grok
```

Windows PowerShell:

```powershell
& "$HOME/.local/share/multi-cli/bin/multi.cmd" login grok
```

Windows cmd:

```bat
"%USERPROFILE%\.local\share\multi-cli\bin\multi.cmd" login grok
```

Use the command for the target shell; Windows installs `.cmd` and `.ps1` shims,
not an extensionless executable.

This helper invokes `grok login` without additional arguments; it does not select
a device flow. For headless sign-in, use the installed CLI's `grok login --help`
and run its supported flow directly in the user's terminal.
`/multi-usage` can report local credential presence, but a refresh token does not
prove the provider still accepts the login. Follow the CLI's authentication result.
Tell the user to relaunch Claude after a successful login to load the Grok
rows. Never accept, request, read, or print credentials in chat; native
credentials remain owned by `grok`.

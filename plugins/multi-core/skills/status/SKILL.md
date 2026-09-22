---
name: status
description: Show enabled Multi providers and the local runtime status.
disable-model-invocation: true
allowed-tools: Bash
---

Run:

Linux/macOS (POSIX shell):

```sh
"$HOME/.local/share/multi-cli/bin/multi" status
```

Windows PowerShell:

```powershell
& "$HOME/.local/share/multi-cli/bin/multi.cmd" status
```

Windows cmd:

```bat
"%USERPROFILE%\.local\share\multi-cli\bin\multi.cmd" status
```

Use the command for the target shell; Windows installs `.cmd` and `.ps1` shims,
not an extensionless executable.

Tell the user which providers are enabled and whether the helper is installed.
This command does not test provider authentication or inference. If it is missing,
tell the user to run `/multi-core:setup`. Never accept credentials in chat.

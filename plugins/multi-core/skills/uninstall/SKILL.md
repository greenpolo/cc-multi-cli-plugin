---
name: uninstall
description: Remove Multi startup files while preserving provider credentials.
disable-model-invocation: true
allowed-tools: Bash
---

Run:

Linux/macOS (POSIX shell):

```sh
"$HOME/.local/share/multi-cli/bin/multi" uninstall
```

Windows PowerShell:

```powershell
& "$HOME/.local/share/multi-cli/bin/multi.cmd" uninstall
```

Windows cmd:

```bat
"%USERPROFILE%\.local\share\multi-cli\bin\multi.cmd" uninstall
```

Use the command for the target shell; Windows installs `.cmd` and `.ps1` shims,
not an extensionless executable.

After a successful exit, report that Multi startup files and its marked shell
block were removed. If the helper fails, report the failure instead.
Provider credentials remain in their provider stores. The command does not remove
Claude plugins; tell the user to remove those through `/plugin` when needed.
Never accept credentials in chat.

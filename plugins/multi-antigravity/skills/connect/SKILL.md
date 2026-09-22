---
name: connect
description: Install the scoped Antigravity permission hook.
disable-model-invocation: true
allowed-tools: Bash
---

Tell the user to complete the official `agy` login first. Then run:

Linux/macOS (POSIX shell):

```sh
"$HOME/.local/share/multi-cli/bin/multi" login antigravity
```

Windows PowerShell:

```powershell
& "$HOME/.local/share/multi-cli/bin/multi.cmd" login antigravity
```

Windows cmd:

```bat
"%USERPROFILE%\.local\share\multi-cli\bin\multi.cmd" login antigravity
```

Use the command for the target shell; Windows installs `.cmd` and `.ps1` shims,
not an extensionless executable.

Tell the user that this installs the hook and does not test inference. Tell them
to relaunch Claude afterward. Never accept, request, read, or print credentials
in chat; native credentials remain owned by `agy`.

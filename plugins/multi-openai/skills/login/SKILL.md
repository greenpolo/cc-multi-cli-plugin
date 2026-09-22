---
name: login
description: Start the official Codex login flow.
disable-model-invocation: true
allowed-tools: Bash
---

Run:

Linux/macOS (POSIX shell):

```sh
"$HOME/.local/share/multi-cli/bin/multi" login openai
```

Windows PowerShell:

```powershell
& "$HOME/.local/share/multi-cli/bin/multi.cmd" login openai
```

Windows cmd:

```bat
"%USERPROFILE%\.local\share\multi-cli\bin\multi.cmd" login openai
```

Use the command for the target shell; Windows installs `.cmd` and `.ps1` shims,
not an extensionless executable.

Tell the user to complete the displayed browser or device login, then report
success only after the command exits successfully. Tell the user to relaunch
Claude afterward. Never accept, request, read, or print credentials in chat.

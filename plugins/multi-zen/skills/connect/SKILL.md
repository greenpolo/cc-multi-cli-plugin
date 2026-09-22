---
name: connect
description: Save an OpenCode Zen API key without exposing it in chat.
disable-model-invocation: true
allowed-tools: Bash
---

Tell the user to run this command in a separate terminal:

Linux/macOS (POSIX shell):

```sh
"$HOME/.local/share/multi-cli/bin/multi" connect zen
```

Windows PowerShell:

```powershell
& "$HOME/.local/share/multi-cli/bin/multi.cmd" connect zen
```

Windows cmd:

```bat
"%USERPROFILE%\.local\share\multi-cli\bin\multi.cmd" connect zen
```

Use the command for the target shell; Windows installs `.cmd` and `.ps1` shims,
not an extensionless executable.

The helper prompts privately and saves the key in OpenCode's auth store. Tell the
user to relaunch Claude afterward. Never accept, request, read, or print the key
in chat or pass it as a command argument.

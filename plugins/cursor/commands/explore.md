---
description: Delegate quick read-only codebase exploration to Cursor (default Auto model)
argument-hint: "[--background|--wait] [--model <model>] <what to explore>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Dispatch to the `multi:cursor-explore` subagent. Cursor runs read-only (ask mode) over the current repository — using semantic search, grep, and its Explore subagent — and returns a focused answer without editing files.

Use this to offload codebase questions ("where is X handled?", "how does Y flow work?", "summarize the adapter layer") to Cursor instead of spending Claude's tokens reading files.

Raw user request:
$ARGUMENTS

- Default foreground; exploration is usually quick. Pass `--background` for a broad survey.
- Pass `--model` through; default is Cursor's Auto model.
- If the request has no target, ask what to explore.

Return the subagent's output verbatim.

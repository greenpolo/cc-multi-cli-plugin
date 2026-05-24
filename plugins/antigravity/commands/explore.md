---
description: Fast codebase exploration with Antigravity (Gemini 3.5 Flash via Antigravity LS, read-only)
argument-hint: "[--model <model>] <what to explore>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Dispatch the user's exploration request to the `multi:antigravity-explorer` subagent via the `Agent` tool. Antigravity runs Gemini 3.5 Flash through the running Antigravity 2.0 desktop's Language Server for fast read-only code ingestion.

Raw user request:
$ARGUMENTS

- Read-only. Antigravity will NOT modify files.
- Requires the Antigravity 2.0 desktop app to be running and signed in.
- If the request has no prompt, ask what to explore.

Return Antigravity's output verbatim.

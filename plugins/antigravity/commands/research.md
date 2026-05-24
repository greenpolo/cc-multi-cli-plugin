---
description: Deep external research with Antigravity (Gemini 3.1 Pro via Antigravity LS — web search + synthesis, read-only)
argument-hint: "[--model <model>] <what to research>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Dispatch the user's research request to the `multi:antigravity-researcher` subagent via the `Agent` tool. Antigravity runs Gemini 3.1 Pro through the running Antigravity 2.0 desktop's Language Server.

Raw user request:
$ARGUMENTS

- This is a read-only research mode. Antigravity will NOT modify files.
- Requires the Antigravity 2.0 desktop app to be running and signed in.
- Pass `--model` through if the user overrides the default.
- If the request has no prompt, ask what to research.

Return Antigravity's output verbatim.

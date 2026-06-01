---
description: "Fast codebase exploration with Antigravity's agy CLI (Gemini 3.5 Flash, read-only). EXPERIMENTAL."
argument-hint: "<what to explore>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Dispatch the user's exploration request to the `multi:antigravity-explorer` subagent via the `Agent` tool. Antigravity runs **Gemini 3.5 Flash** through Google's headless `agy` CLI (`agy -p`) for fast read-only code ingestion.

Raw user request:
$ARGUMENTS

- Read-only. Antigravity will NOT modify files.
- Requires the `agy` CLI installed and signed in once (run `agy` interactively to sign in). The Antigravity desktop app is NOT required.
- **EXPERIMENTAL**: the answer is recovered from agy's conversation transcript. The model is fixed to Gemini 3.5 Flash.
- If the request has no prompt, ask what to explore.

Return Antigravity's output verbatim.

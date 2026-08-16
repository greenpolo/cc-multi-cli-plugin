---
description: "Deep external research with Antigravity's agy CLI (Gemini 3.7 Flash — web search + synthesis, read-only). EXPERIMENTAL."
argument-hint: "<what to research>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Dispatch the user's research request to the `multi:antigravity-researcher` subagent via the `Agent` tool. Antigravity runs **Gemini 3.7 Flash** through Google's headless `agy` CLI (`agy -p`), with built-in web search.

Raw user request:
$ARGUMENTS

- Read-only research mode — Antigravity will NOT modify files.
- Requires the `agy` CLI installed and signed in once (run `agy` interactively to sign in). The Antigravity desktop app is NOT required.
- **EXPERIMENTAL**: the answer is recovered from agy's conversation transcript (its headless stdout is empty, an upstream bug). The model is fixed to Gemini 3.7 Flash; `--model` is not honored on this path.
- If the request has no prompt, ask what to research.

Return Antigravity's output verbatim.

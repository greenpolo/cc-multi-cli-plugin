---
description: Delegate read-only external web/documentation research to Cursor (default Auto model)
argument-hint: "[--background|--wait] [--model <model>] <research question>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Dispatch to the `multi:cursor-research` subagent. Cursor runs read-only (ask mode) with web access — it searches the web and fetches documentation, then returns findings with sources. It never edits files.

Use this to offload external research (library docs, API changes, "what's the current way to…", comparing approaches) to Cursor so it doesn't consume Claude's context/tokens.

Raw user request:
$ARGUMENTS

- Default foreground; research is usually a single turn. Pass `--background` for a deep/long investigation.
- Pass `--model` through; default is Cursor's Auto model.
- If the request has no question, ask what to research.

Return the subagent's output verbatim.

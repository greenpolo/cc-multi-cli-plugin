---
description: Delegate execution of a specific plan or plan step to Cursor (Agent mode, Auto model)
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] <plan step to execute>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `multi:cursor-execute` subagent via the `Agent` tool, forwarding the user's request as the prompt.

The subagent runs Cursor in Agent mode on Auto model — give it a concrete, well-defined plan step and Cursor implements it with full tool access. Cursor is the fast lane: pick it over `/codex:execute` when the spec is clear, the work is mostly mechanical (long file writes, pattern application across many files, 200+ lines of code), and you want throughput over deep reasoning.

Raw user request:
$ARGUMENTS

Execution:

- Default to foreground for small steps; pass `--background` for multi-file work expected to take more than ~3 minutes.
- The subagent uses Cursor's Auto model by default. If the user passes `--model`, that wins.
- If the user passes `--resume`, the subagent will continue the latest Cursor execute thread for this repo.
- If the request includes no prompt text, ask what Cursor should implement before proceeding.

Return Cursor's output verbatim.
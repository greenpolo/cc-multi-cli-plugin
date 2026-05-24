---
description: Run a Codex code review of your working tree or a branch (read-only)
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] <optional focus>"
allowed-tools: AskUserQuestion, Agent
---

Invoke the `multi:codex-review` subagent via the `Agent` tool, forwarding the user's request as the prompt.

The subagent runs Codex's reviewer over your changes and returns structured findings. It is read-only — Codex never edits files during a review.

This is distinct from `/codex:execute` (writes code) and `/codex:rescue` (open-ended investigation). Use `/codex:review` when you want a code review or PR audit.

Raw user request:
$ARGUMENTS

Execution:

- Preserve `--wait`/`--background`/`--base`/`--scope` for the forwarded command — the subagent reads them.
- Default to foreground for small diffs; the subagent escalates to background for large or unclear scope.
- If no focus text is given, the subagent reviews the full working-tree diff by default.

Return Codex's review output verbatim.

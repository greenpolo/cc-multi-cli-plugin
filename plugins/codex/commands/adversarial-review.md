---
description: Adversarial design/code review with Codex — challenges the approach, not just the diff (read-only)
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] <what to challenge>"
allowed-tools: AskUserQuestion, Agent
disable-model-invocation: true
---

Invoke the `multi:codex-review` subagent via the `Agent` tool, forwarding the user's request as the prompt and signaling ADVERSARIAL intent so the subagent routes to the companion's `adversarial-review` subcommand (not plain `review`).

This runs Codex as a skeptical reviewer: it stress-tests the design decision, looks for the strongest counter-argument, and surfaces risks rather than rubber-stamping. Read-only — Codex never edits files.

Use this when you want your approach challenged ("is this the right design?", "what am I missing?"), not just a line-by-line diff review.

Raw user request:
$ARGUMENTS

Execution:

- Preserve `--wait`/`--background`/`--base`/`--scope` for the forwarded command.
- Tell the subagent explicitly this is an ADVERSARIAL review so it selects the `adversarial-review` subcommand.

Return Codex's review output verbatim.

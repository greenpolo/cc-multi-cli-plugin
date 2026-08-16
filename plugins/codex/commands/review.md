---
description: Run a Codex code review of your working tree or a branch (read-only)
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

Run Codex's reviewer over the current changes with exactly one Bash call:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" review $ARGUMENTS 2>&1`

This is read-only — Codex never edits files during a review. It is distinct from
`/codex:execute` (writes code) and `/codex:rescue` (open-ended investigation).

Execution:

- Pass `--wait`/`--background`/`--base`/`--scope` through verbatim; add nothing else. Never pass `--write`.
- With no `--base`/`--scope`, the companion reviews the full working-tree diff.
- Small diffs: run in the foreground. Large or unclear scope: run the same call with `run_in_background: true` and report the review when it finishes.
- Do not review the code yourself, read files, or summarize. Return the companion's stdout verbatim.
- If the Bash call fails or returns nothing, your entire response is one line: `Codex review failed: <one-line reason>`.

---
description: Adversarial design/code review with Codex — challenges the approach, not just the diff (read-only)
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] <what to challenge>"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

Run Codex as a skeptical reviewer with exactly one Bash call:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" adversarial-review $ARGUMENTS 2>&1`

Codex stress-tests the design decision, looks for the strongest counter-argument, and
surfaces risks rather than rubber-stamping. Read-only — it never edits files. Use this
when you want the approach challenged, not just a line-by-line diff review.

Execution:

- Pass `--wait`/`--background`/`--base`/`--scope` through verbatim; remaining text is the focus and goes through unchanged. Never pass `--write`.
- Small diffs: run in the foreground. Large or unclear scope: run the same call with `run_in_background: true` and report the review when it finishes.
- Do not review the code yourself, read files, or summarize. Return the companion's stdout verbatim.
- If the Bash call fails or returns nothing, your entire response is one line: `Codex adversarial review failed: <one-line reason>`.

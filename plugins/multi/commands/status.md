---
description: Show active and recent multi-CLI background jobs (codex, gemini, cursor, copilot) for this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, CLI, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.

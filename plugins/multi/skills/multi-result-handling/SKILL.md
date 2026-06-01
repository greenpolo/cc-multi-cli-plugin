---
name: multi-result-handling
description: Internal guidance for presenting multi:* helper output back to the user
user-invocable: false
---

# Multi-CLI Result Handling

When a `multi:*` subagent returns helper output (Codex, Cursor, Antigravity via multi, or any CLI added via `multi-cli-anything`):

## Preserving the helper's structure

- Preserve the helper's verdict, summary, findings, and next-steps sections exactly. Do not paraphrase, re-order, or summarize them in your own words.
- If the helper produced a structured final report (markdown headers like `## Outcome`, `## Files touched`, `## Verification`, `## Notes`), surface those sections as the canonical answer. Your commentary, if any, should reference the report — not restate it.
- Use the file paths and line numbers exactly as the helper reports them. Do not normalize Windows backslashes to forward slashes or vice versa.
- Preserve evidence boundaries. If the helper marked something as an inference, an uncertainty, or an open question, keep that distinction in your reply.

## When the helper's output is messy

Some upstream CLIs stream chain-of-thought tokens interleaved with the final answer. When you see a mix of reasoning prose and a structured final report:

- Present the structured final report as the answer.
- Optionally quote 1–2 short lines of reasoning if they explain a non-obvious choice — never paraphrase the whole stream.
- If there is no structured final section, fall back to presenting the helper's last coherent paragraph as the result and note that explicitly.

## Touched files and verification

- If the helper made edits, say so explicitly and list the touched files when the helper provides them.
- If the helper ran shell commands or other verification steps, surface those exit codes and outputs.
- If the helper says it ran something but no exit code or output is visible, flag that gap rather than assuming success.

## Failed runs

- If the helper reports a failed run (exit non-zero, or the failure line `<CLI> <role> failed: ...`), report the failure with the most actionable stderr lines and stop. Do not turn a failed helper run into a Claude-side implementation attempt.
- If the helper was never successfully invoked (binary missing, auth failure, sandbox block), do not generate a substitute answer at all. Direct the user to `/multi:setup` and stop.
- If the helper reports malformed output, include the most actionable stderr lines and stop there instead of guessing.

## Review-style output

For research, review, or diagnosis output from `multi:antigravity-researcher`, `multi:codex-review`, `multi:antigravity-explorer`, `multi:cursor-research`, etc.:

- Present findings first, ordered by severity if the helper provided severity labels.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- **CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. Explicitly ask the user which issues, if any, they want fixed before touching a single file.** Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.

## Background jobs

- If the helper launched a background job, the rendered output already shows the job ID. Do not promise to "check back later" or "report when done" — you cannot be re-woken when background jobs finish.
- Direct the user to `/multi:status <job-id>` for live progress and `/multi:result <job-id>` for the final output. Stop there.

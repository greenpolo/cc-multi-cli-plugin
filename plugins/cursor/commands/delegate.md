---
description: Delegate an implementation task or plan step to Cursor (agentic, writes code; default Auto model)
argument-hint: "[--plan <path>] [--background|--wait] [--resume|--fresh] [--until-done] [--max-turns <n>] [--model <model>] <plan step or task>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `multi:cursor-delegate` subagent via the `Agent` tool, forwarding the user's request as the prompt.

The subagent runs Cursor in agent mode on the Auto model — give it a concrete, well-defined task or plan step and Cursor implements it (reads, writes, edits). Cursor is the fast lane: pick it over `/codex:execute` when the spec is clear and the work is mostly mechanical (long file writes, pattern application across many files, bulk refactors) and you want throughput.

**Verification is yours, not Cursor's.** Cursor's shell is slow/unreliable on Windows, so the subagent does not run build/test suites — it lists the commands to run in a `## Verification` block. After it returns, run those commands with your own Bash tool and surface the results.

Raw user request:
$ARGUMENTS

Execution:

- **Plan-by-reference (preferred when applicable):** if a plan file is in conversation context (Plan mode `Plan File Info` block, a path like `~/.claude/plans/*.md`, or a plan you authored this session), pass `--plan <path>` instead of paraphrasing. The subagent translates `--plan` to `--prompt-file` and Cursor reads the file's bytes directly. See the `multi-plan-handoff` skill for detection rules. Trigger phrases like "execute via cursor", "delegate to cursor", "send this plan to cursor" all qualify.
- For small steps, invoke the subagent in the foreground. For multi-file work expected to take more than ~3 minutes, invoke the subagent with the `Agent` tool's `run_in_background: true`: the subagent runs Cursor to completion in the foreground, so the harness notifies you with a `<task-notification>` when it finishes or fails — instead of stalling silently. Do NOT add the companion's `--background` flag for this (it detaches a worker the harness can't see); keep `--background` for explicit fire-and-forget polled via `/multi:status`. (Unlike Codex, Cursor has no inactivity watchdog, so a truly wedged Cursor process won't self-fail — but completion and errors still notify.)
- The subagent uses Cursor's Auto model by default. If the user passes `--model`, that wins.
- If the user passes `--resume`, the subagent continues the latest Cursor delegate session for this repo.
- **Autonomous multi-step (`--until-done`):** when the user hands off a whole multi-step plan and wants Cursor to run end-to-end without re-dispatch, pass `--until-done` (optionally with `--max-turns <n>`). The subagent loops Cursor turns on the same session until it signals completion, hits the turn ceiling, errors, or stops making progress. For long autonomous runs, invoke the subagent with `run_in_background: true` (foreground companion) so you're notified when it finishes — avoid the companion's detached `--background`. Default off.
- If the request includes no prompt text AND no plan file in context, ask what Cursor should implement before proceeding.

After the subagent returns, read its `## Verification` section, run those commands via your own Bash tool, then surface Cursor's report and your verification results to the user.

Return Cursor's output verbatim, followed by your verification results.

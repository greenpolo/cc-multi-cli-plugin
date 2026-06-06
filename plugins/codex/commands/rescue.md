---
description: Hand a stuck or open-ended problem to Codex for an independent investigation or rescue pass
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <low|medium|high|xhigh>] <what you're stuck on>"
allowed-tools: AskUserQuestion, Agent
---

Invoke the `multi:codex-rescue` subagent via the `Agent` tool, forwarding the user's request as the prompt.

The subagent runs Codex in open-ended rescue mode — hand it a stuck problem, a confusing bug, or a substantial unbounded task and it investigates independently.

This is distinct from `/codex:execute` (structured execution of a clear plan step) and `/codex:review` (read-only review). Use `/codex:rescue` when Claude is stuck, wants a second opinion, or needs a deeper root-cause investigation.

Raw user request:
$ARGUMENTS

Execution:

- For a small, clearly bounded rescue, invoke the subagent in the foreground (blocking) — the result comes back inline.
- For an open-ended, multi-step, or long-running investigation, invoke the subagent with the `Agent` tool's `run_in_background: true`. The subagent runs Codex to completion in the foreground, so the harness wakes you with a `<task-notification>` the moment Codex finishes, errors, OR the inactivity watchdog kills a hang — even after this turn ends. This is the path that surfaces failures instead of stalling silently.
- Do NOT add the companion's `--background` flag to get this — that detaches a worker the harness cannot see (no notification). Reserve `--background` for explicit fire-and-forget the user wants to poll via `/multi:status`.
- Preserve `--model`, `--effort`, `--resume`, `--fresh` for the forwarded command — the subagent reads them.
- If the user passes `--resume`, the subagent continues the latest Codex thread for this repo; otherwise it starts fresh.
- If the request includes no prompt text, ask what Codex should investigate before proceeding.

Return Codex's output verbatim once the subagent completes.

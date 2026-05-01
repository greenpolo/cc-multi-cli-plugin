---
description: Delegate execution of a specific plan or plan step to Codex
argument-hint: "[--plan <path>] [--background|--wait] [--resume|--fresh] [--model <model>] [--effort <low|medium|high|xhigh>] <plan step or addendum>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `multi:codex-execute` subagent via the `Agent` tool, forwarding the user's request as the prompt.

The subagent runs Codex in structured-execution mode — give it a concrete plan step, it implements it.

This is distinct from the official `openai-codex` plugin's `/codex:rescue`, which handles open-ended rescue. Use `/codex:execute` when you have a clear plan step; use `/codex:rescue` when Claude is stuck.

Raw user request:
$ARGUMENTS

Execution:

- **Plan-by-reference (preferred when applicable):** if a plan file is in conversation context (Plan mode `Plan File Info` block, a path like `~/.claude/plans/*.md`, or a plan you authored this session), pass `--plan <path>` instead of paraphrasing. The subagent translates `--plan` to `--prompt-file` and Codex reads the file's bytes directly. See the `multi-plan-handoff` skill for full detection rules. Trigger phrases like "execute it via codex", "delegate to codex", "send this plan to codex" all qualify.
- Default to foreground. If the user passes `--background`, launch the subagent in a Claude background task.
- Preserve `--model` and `--effort` flags for the forwarded command — the subagent reads them.
- If the user passes `--resume`, the subagent will continue the latest Codex execute thread for this repo.
- If the request includes no prompt text AND no plan file in context, ask what Codex should implement before proceeding.

Return Codex's output verbatim.

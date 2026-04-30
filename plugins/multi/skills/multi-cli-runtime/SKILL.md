---
name: multi-cli-runtime
description: Internal helper contract for calling the multi-cli-companion runtime from any multi:* subagent
user-invocable: false
---

# Multi-CLI Runtime

Use this skill only inside `multi:*` forwarding subagents (`cursor-execute`, `cursor-planner`, `cursor-debugger`, `gemini-explorer`, `gemini-researcher`, `copilot-planner`, `copilot-researcher`, `copilot-reviewer`, `qwen-writer`, etc.).

## Primary helper

`node "${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs" task --cli <cli> --role <role> [flags] --prompt "<text>"`

Where `<cli>` is one of `codex|gemini|cursor|copilot|qwen` (or any CLI added via the `multi-cli-anything` skill) and `<role>` is the subagent's logical role (`execute`, `planner`, `writer`, `debugger`, `researcher`, `reviewer`, `explorer`, `ask`).

## Execution rules

- Each `multi:*` subagent is a forwarder, not an orchestrator. Its only job is to invoke the companion once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct CLI strings (`cursor agent acp`, `gemini --acp`, `copilot --acp --stdio`, `codex exec`), or any other Bash activity.
- Use exactly one Bash call per subagent dispatch. Do not chain `cat`, `sleep`, polling loops, or follow-up `node` calls.

## Routing flag handling

Treat these as runtime controls — strip them from the task text before forwarding, then re-add them as flags on the companion call:

- `--background` / `--wait` — foreground vs background scheduling. Default foreground for clearly bounded tasks; default background for open-ended or long-running work.
- `--model <name>` — pass through verbatim. Leave unset unless the user explicitly asked for a model.
- `--effort <level>` — only Codex accepts this (`none|minimal|low|medium|high|xhigh`). Other adapters ignore it. Pass through verbatim if present.
- `--resume` — translate to `--resume-last`.
- `--fresh` — do not add `--resume-last`, even if the user's text sounds like a follow-up.
- `--write` — default to `--write` for execute/writer/debugger/reviewer roles (these need to edit files); omit for planner/researcher/explorer/ask (read-only by intent). Honor explicit user override either way.

## Capturing diagnostics

Always append `2>&1` to the Bash call so the parent thread can see runtime diagnostics if the companion fails.

## Safety rules

- Preserve the user's task text as-is apart from stripping routing flags and prepending the subagent's role-specific framing block.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or the upstream CLI cannot be invoked, return a single short failure line: `<CLI> <role> failed: <one-line reason from stderr or "no output">`. Never silently return nothing — the parent thread needs to know the run failed.
- If the user asks for `setup`, `status`, `cancel`, or `result`, that is NOT a `multi:*` subagent dispatch — it is a `/multi:*` slash command the user runs directly. Do not call those subcommands from within a forwarding subagent.

## Forbidden behaviors

- Do NOT paraphrase or rewrite the companion output, even if it looks like a status update or progress message.
- Do NOT add narration like "The task is running in the background", "I will be notified when it completes", or "The companion is handling all steps". The companion already prints whatever the user needs to see.
- Do NOT promise to deliver later results. The subagent exits when its Bash call returns; it cannot be re-woken by background jobs finishing. If the companion launched a background task, the user has the job ID — let them poll `/multi:status` themselves.
- Do NOT invent fabricated output if Bash returned empty or non-zero. Use the failure line format above.

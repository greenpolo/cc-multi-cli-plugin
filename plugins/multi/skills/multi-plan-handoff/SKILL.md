---
name: multi-plan-handoff
description: Auto-detect plan files in conversation context and pass them to multi:* execute subagents by reference, not by paraphrase
user-invocable: false
---

# Multi-CLI Plan Handoff

When the user asks to delegate work to a `multi:*` execute/delegate subagent (`multi:codex-execute`, `multi:cursor-delegate`, `multi:opencode-delegate`, or any future execute/delegate subagent), you must check whether a plan file exists in conversation context. If one does, dispatch the subagent with `--plan <path>` and **never** paste the plan's content into the Agent tool's prompt.

The reason: every paraphrasing layer (you summarizing the plan, the Sonnet wrapper prepending framing, the upstream CLI re-reading prose) loses fidelity. `--plan <path>` makes the upstream CLI read the file directly — bytes-identical, zero rewriting.

## Detection — when is there a plan in context?

Scan recent conversation for these signals, in priority order:

1. **Plan mode `Plan File Info` block.** When Claude Code's plan mode is or was active, system reminders contain a line like:
   `You should create your plan at C:\Users\<user>\.claude\plans\<slug>.md`
   That path is canonical even after `ExitPlanMode` — the file persists. If you see this in any system reminder this session, treat it as the active plan file.

2. **Superpowers `writing-plans` output.** The `superpowers:writing-plans` skill writes plan files to a known location and announces the path in its output. If you used or saw it this session, that path is in scope.

3. **Explicit user reference.** Any path the user typed or that you wrote that matches one of:
   - `*/.claude/plans/*.md`
   - `*/plans/*.md` (project-local plans)
   - A path the user explicitly called "the plan" or "the spec"

4. **A plan you just authored.** If you wrote a markdown file in this session whose path includes `/plans/` and whose contents are step-by-step instructions, that's a plan.

## Trigger phrases

Apply this skill when the user says any of these (case-insensitive, fuzzy):

- "execute it via codex" / "send to codex" / "delegate to codex" / "have codex implement this" / "codex it"
- "execute via cursor" / "send to cursor" / "delegate to cursor" / "cursor it"
- "execute via opencode" / "send to opencode" / "delegate to opencode" / "opencode it"
- "execute the plan" (with no path — auto-resolve from context)
- Any explicit "/codex:execute", "/cursor:delegate", or "/opencode:delegate" with no inline prompt text

If the user explicitly types a prompt rather than referencing a plan ("write me a fizzbuzz via cursor"), don't apply this skill — that's a normal prompt-based dispatch.

## Dispatch behavior

When detection matches:

1. **Resolve to exactly one path.** If multiple plan files are in context, ask the user which one (one short sentence, no menu of options unless 3+).

2. **Dispatch with `--plan <path>`.** Pass the absolute path through the Agent tool's prompt as `--plan <absolute-path>` (plus any other runtime flags the user specified like `--background`, `--model`, `--effort`).

3. **Do not paste plan content.** The Agent tool's prompt should contain the path reference, NOT the plan's text. The subagent translates `--plan` to `--prompt-file` on the companion call and skips the framing block.

4. **Inline addenda go after the path.** If the user adds something like "execute the plan via codex but also add a CHANGELOG entry", append the addendum as plain text after the `--plan <path>` flag in the dispatch prompt. The subagent will pass the path as `--prompt-file` AND append the addendum as additional task text. Example:
   `--plan C:/Users/.../plans/foo.md add a CHANGELOG.md entry dated 2026-04-30 documenting the change`

5. **Re-read on dispatch.** If the user edited the plan file mid-conversation, the file's current bytes are what gets used — the subagent reads from disk, not from your context. Trust the file.

## What NOT to do

- **Never paraphrase a plan you can pass by reference.** The whole point of this skill is that paraphrasing is lossy.
- **Never combine `--plan` with the subagent's framing block.** When `--plan` is present, the subagent drops its preamble and passes the plan file as the entire prompt body.
- **Never invent a plan file path.** If detection produces nothing, fall through to the normal prompt flow and ask the user what to delegate.
- **Never read the plan file yourself just to summarize it back.** The subagent and the upstream CLI handle the file directly.

## Worked example

User in conversation:
- *(plan mode produces ~/.claude/plans/cursor-format-test.md)*
- *(user exits plan mode)*
- User: "send it to cursor"

Wrong (current behavior):
- You: *(reads plan file, paraphrases into a 200-word Agent prompt)*
- Subagent: *(prepends framing, forwards 250 words)*
- Cursor: receives third-generation rewrite

Right (with this skill):
- You: dispatch `multi:cursor-delegate` with prompt: `--plan C:/Users/.../plans/cursor-format-test.md`
- Subagent: `node ... task --cli cursor --role delegate --prompt-file C:/Users/.../plans/cursor-format-test.md --write`
- Cursor: reads the file directly, bytes-identical to what was authored

The same pattern applies to the other delegate subagents. For "send it to opencode":
- You: dispatch `multi:opencode-delegate` with prompt: `--plan C:/Users/.../plans/cursor-format-test.md`
- Subagent: `node ... task --cli opencode --role delegate --prompt-file C:/Users/.../plans/cursor-format-test.md --write`
- OpenCode: reads the file directly, bytes-identical to what was authored

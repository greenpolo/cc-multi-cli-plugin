import { harnessHistoryHash } from '../../multi-core/src/gateway/harness-notices.ts';
import { prepareNativePrompt } from '../../multi-core/src/gateway/harness-prompt.ts';
import type { MessagesRequest } from '../../multi-core/src/gateway/messages.ts';

const PREAMBLE =
  'You are the Codex coding agent displayed inside Claude Code. Complete the task using ' +
  'your native tools and permissions, verify changes, and report results. Previously ' +
  'recorded actions are complete; do not repeat them.';

/**
 * Identity follows the prompt actually typed, so every reminder is stripped from it: a
 * retry that only carries a fresh reminder is the same request and must not run twice.
 */
export function codexHistoryHash(messages: MessagesRequest['messages']): string {
  return harnessHistoryHash(messages, { stripReminders: true });
}

/**
 * Turn the new part of a Claude conversation into one Codex prompt. Codex applies its own
 * system prompt, tools and AGENTS.md, and keeps its thread, so Claude's `system` and the
 * catalogues of Claude tools it cannot call are dropped; the project's instructions, hook
 * output and recalled memories are forwarded, since Codex reaches none of them otherwise.
 */
export function prepareCodexRequest(body: MessagesRequest) {
  return prepareNativePrompt(body, {
    provider: 'Codex',
    preamble: PREAMBLE,
    stripCatalogues: true,
    dropEmptyTurns: true,
  });
}

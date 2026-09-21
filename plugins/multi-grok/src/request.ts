import { harnessHistoryHash } from '../../multi-core/src/gateway/harness-notices.ts';
import { prepareNativePrompt } from '../../multi-core/src/gateway/harness-prompt.ts';
import type { MessagesRequest } from '../../multi-core/src/gateway/messages.ts';

const PREAMBLE =
  'You are the Grok Build coding agent displayed inside Claude Code. Complete the task ' +
  'using your native tools and permissions, verify changes, and report results and any ' +
  'denied actions. Previously recorded actions are complete; do not repeat them. Do not ' +
  'spawn child agents or external coding CLIs.';

/**
 * Cache markers are transport metadata; moving them must not fork native history.
 * Identity follows the prompt actually typed, so every reminder is stripped from it:
 * a retry that only carries a fresh reminder — a new catalogue, a recalculated memory
 * recall, an updated environment block — is the same request, and must not run twice.
 */
export function grokHistoryHash(messages: MessagesRequest['messages']): string {
  return harnessHistoryHash(messages, { stripReminders: true });
}

/**
 * Convert Messages context into one authenticated Grok prompt: a fixed preamble plus
 * the conversation text. The CLI applies its own system prompt and reads the repo's
 * AGENTS.md natively, so Claude's `system` is never forwarded. Native tools stay in
 * the CLI. Claude's deferred-tool, skill, MCP and subagent catalogues describe
 * capabilities this provider cannot call and are dropped; everything else — the
 * project's own instructions, Auto Mode notices, hook output and recalled memories —
 * is forwarded, since the CLI reaches none of it any other way.
 * `native-grok-request.test.ts` pins both halves against a live session's captured
 * reminder blocks, so a Claude Code rename fails a test instead of silently dropping
 * or forwarding the wrong thing.
 */
export function prepareGrokRequest(body: MessagesRequest, model = body.model ?? '') {
  const prepared = prepareNativePrompt(body, {
    provider: 'Grok',
    preamble: PREAMBLE,
    stripCatalogues: true,
    dropEmptyTurns: true,
  });
  return { ...prepared, model };
}

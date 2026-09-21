import { harnessHistoryHash } from '../../multi-core/src/gateway/harness-notices.ts';
import { prepareNativePrompt } from '../../multi-core/src/gateway/harness-prompt.ts';
import type { MessagesRequest } from '../../multi-core/src/gateway/messages.ts';

const PREAMBLE =
  'You are the Antigravity coding agent displayed inside Claude Code. Complete the task ' +
  'using your native tools and permissions, verify changes, and report results and any ' +
  'denied actions. Previously recorded actions are complete; do not repeat them. Do not ' +
  'spawn child agents or external coding CLIs.';

/** Cache markers are transport metadata; moving them must not fork native history. */
export function antigravityHistoryHash(messages: MessagesRequest['messages']): string {
  return harnessHistoryHash(messages);
}

/**
 * Convert Messages context into one authenticated agy prompt: a fixed preamble plus the
 * conversation text. `agy` applies its own system prompt and reads the repo's AGENTS.md
 * natively, so Claude's `system` is never forwarded. Native tools stay in agy.
 */
export function prepareAntigravityRequest(body: MessagesRequest, model = body.model ?? '') {
  const prepared = prepareNativePrompt(body, { provider: 'Antigravity', preamble: PREAMBLE });
  return { ...prepared, model };
}

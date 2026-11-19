import type { MultiCorePrompt } from '../types/multi-core.d.ts';
import { postJson, type Wire } from './gateway.ts';

export type PromptSnapshot = MultiCorePrompt;

/** A prompt's identity as the gateway holds it: what, with the model, decides a repost. */
export function snapshotKey(snapshot: PromptSnapshot, model: string): string {
  return JSON.stringify([snapshot.sessionId, snapshot.cwd, snapshot.permissionMode ?? null, model]);
}

/**
 * Tell the gateway the mode, workspace and model of this prompt: the one record every
 * provider and every worker of the session reads. True once the gateway holds it.
 */
export async function recordPrompt(
  wire: Wire,
  snapshot: PromptSnapshot,
  model: string,
): Promise<boolean> {
  const response = await postJson(wire, '/multi/mod/session', {
    ...snapshot,
    model,
    event: 'prompt',
  });
  return Boolean(response?.accepted);
}

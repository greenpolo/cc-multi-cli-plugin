import type { EngineInterface, Register } from 'claude-code';
import { atom, read, update } from 'claude-code';
import { accepted, getJson, isActive, postJson, type Wire } from './gateway.ts';
import { isHarnessModel } from './provider.ts';

// State values are named where they are read: the engine's scan reads an atom's plugin and key
// from this file's own source, not across an import.
const agentModels = atom(
  { plugin: 'multi-core', key: 'agentModels' } as const,
  {} as Record<string, string>,
);

const modKeys = atom(
  { plugin: 'multi-core', key: 'modKeys' } as const,
  {} as Record<string, string>,
);

const wire = ($: EngineInterface): Wire => ({
  url: () => $.env.get('MULTI_MOD_GATEWAY_URL'),
  token: () => $.env.get('MULTI_GATEWAY_TOKEN'),
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  keys: { read: () => read($, modKeys), save: (change) => update($, modKeys, change) },
});

export const register = (on: Parameters<Register>[0], _options: Parameters<Register>[1]) => {
  on('session.compact', async ($, event, next) => {
    // session.model() describes only the main loop. A Claude child must never
    // inherit its external parent's compaction policy (or the reverse).
    const model = await compactionModel($, event.agentId);
    if (!isHarnessModel(model)) {
      return next(event);
    }
    if (!(await isActive(wire($)))) {
      return next(event);
    }
    if (event.trigger === 'precompute') {
      // No summary is prepared ahead of time: that would be a model run nobody asked for.
      return { skip: 'Multi prepares no summary ahead of compaction.' };
    }
    // Best effort: the gateway runs the summary turn without native tools. A gateway that
    // does not answer never stops the compaction.
    const sessionId = await $.session.id();
    const mode = accepted(await getJson(wire($), '/multi/mod/mode', { sessionId }));
    if (typeof mode?.generation === 'number') {
      await postJson(wire($), '/multi/mod/compact/authorize', {
        sessionId,
        agentId: event.agentId,
        generation: mode.generation,
      });
    }
    return next(event);
  });
};

/** The main model is never evidence of a child's provider. */
async function compactionModel(
  $: EngineInterface,
  agentId: string | undefined,
): Promise<string | undefined> {
  return agentId ? (await read($, agentModels))[agentId] : $.session.model();
}

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
    const sessionId = await $.session.id();
    const mode = accepted(await getJson(wire($), '/multi/mod/mode', { sessionId }));
    if (typeof mode?.generation !== 'number') {
      return { skip: 'Multi compaction policy generation is unavailable.' };
    }
    const payload = {
      sessionId,
      agentId: event.agentId,
      generation: mode.generation,
      trigger: event.trigger,
      messages: event.messages,
      instructions: event.instructions,
    };
    if (event.trigger === 'precompute') {
      await precompute($, payload);
      return { skip: 'Multi summary preparation runs outside the hook budget.' };
    }
    const result = accepted(await postJson(wire($), '/multi/mod/compact/authorize', payload));
    if (result?.messages) {
      return { messages: result.messages };
    }
    if (result?.allow) {
      return next(event);
    }
    // Oversized transcripts still require a separate, small tool-free authorization.
    const fallback = accepted(
      await postJson(wire($), '/multi/mod/compact/authorize', {
        sessionId,
        agentId: event.agentId,
        generation: mode.generation,
      }),
    );
    if (!fallback?.allow) {
      return { skip: 'Multi tool-free compaction authorization was not acknowledged.' };
    }
    return next(event);
  });
};

async function precompute($: EngineInterface, payload: Record<string, unknown>) {
  const prepared = accepted(await postJson(wire($), '/multi/mod/compact/precompute', payload));
  if (prepared?.accepted && prepared.precomputeId) {
    // The gateway starts the summary and answers at once, so the hook can await it.
    await postJson(wire($), '/multi/mod/compact/run', {
      sessionId: payload.sessionId,
      agentId: payload.agentId,
      generation: payload.generation,
      precomputeId: prepared.precomputeId,
    });
  }
}

/** The main model is never evidence of a child's provider. */
async function compactionModel(
  $: EngineInterface,
  agentId: string | undefined,
): Promise<string | undefined> {
  return agentId ? (await read($, agentModels))[agentId] : $.session.model();
}

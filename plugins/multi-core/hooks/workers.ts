import type { AgentSpawnInput, EngineInterface, Register } from 'claude-code';
import { atom, read, update } from 'claude-code';
import type { MultiCoreDisplayTools, MultiCorePolicy } from '../types/multi-core.d.ts';
import {
  accepted,
  type GatewayResponse,
  getJson,
  isActive,
  postJson,
  type Wire,
} from './gateway.ts';
import { ensureHarnessPolicy, policyClient } from './policy.ts';
import { isHarnessModel, isMultiModel } from './provider.ts';
import { type RowsClient, syncDisplayTools } from './rows.ts';
import { defined, rememberBounded, withBounded, withItem } from './state.ts';
import { isProviderWorker, labelled, register as registerWorkerRows } from './worker-rows.ts';

// State values are named where they are read: the engine's scan reads an atom's plugin and key
// from this file's own source, not across an import.
const policy = atom({ plugin: 'multi-core', key: 'policy' } as const, {} as MultiCorePolicy);
const agentModels = atom(
  { plugin: 'multi-core', key: 'agentModels' } as const,
  {} as Record<string, string>,
);
const spawnModels = atom(
  { plugin: 'multi-core', key: 'spawnModels' } as const,
  {} as Record<string, string>,
);
const claudeTypes = atom({ plugin: 'multi-core', key: 'claudeTypes' } as const, [] as string[]);
const offeredProviders = atom(
  { plugin: 'multi-core', key: 'offeredProviders' } as const,
  [] as string[],
);
const displayTools = atom(
  { plugin: 'multi-core', key: 'displayTools' } as const,
  { registered: [] } as MultiCoreDisplayTools,
);

const rowsClient = ($: EngineInterface): RowsClient => ({
  wire: wire($),
  sessionId: () => $.session.id(),
  held: () => read($, displayTools),
  save: (change) => update($, displayTools, change),
  register: (tool) => $.tool.register(tool),
});

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

const issues =
  'https://github.com/greenpolo/cc-multi-cli-plugin/issues/new?template=bug_report.yml';

/**
 * A refusal the agent reads, with the invitation to report it.
 *
 * Most refusals are the plugin working: a mode the user chose, a worker their
 * settings do not offer. The invitation is conditional so an ordinary denial
 * does not become an issue, and it never files anything on the user's behalf.
 */
function reportable(reason: string) {
  return `${reason}\n\nIf this reads like a defect in the multi-cli plugin rather than a permission the user chose, tell them so and offer to open an issue at ${issues}, quoting the reason above.`;
}

type SpawnEvent = AgentSpawnInput;

/**
 * The model an Agent call named for a provider worker, by tool_use_id. The Agent tool's
 * schema only admits Claude aliases, so `tool.call` (which runs before the engine checks
 * the input) takes the value out and `agent.spawn` resolves it against the catalog. It
 * lives from that `tool.call` to its `agent.spawn`, inside one call, so it is not state.
 */
const requestedModels = new Map<string, string>();

const providerGuidance =
  "\n\nFor a multi-* agent type (multi-cursor, multi-openai, ...), `model` names one of that provider's models from the type's description, not a Claude alias; omit it for the provider's default.";

export const register = (on: Parameters<Register>[0], _options: Parameters<Register>[1]) => {
  registerWorkerRows(on);
  on('tool.describe', { tool: 'Agent' }, async ($, event, next) => {
    const described = await next(event);
    // The paragraph is for the provider types the model is offered; none, no paragraph.
    if (!(await isActive(wire($))) || !(await read($, offeredProviders)).length) {
      return described;
    }
    return { ...described, description: `${described.description}${providerGuidance}` };
  });
  on('tool.call', { tool: 'Agent' }, async ($, event, next) => {
    if (event.tool !== 'Agent' || event.model === undefined) {
      return next(event);
    }
    if (!isProviderWorker(event.subagent_type) || !(await isActive(wire($)))) {
      return next(event);
    }
    rememberBounded(requestedModels, event.tool_use_id, String(event.model));
    const { model: _named, ...call } = event;
    try {
      return await next(call);
    } finally {
      requestedModels.delete(event.tool_use_id);
    }
  });
  on('agent.offer', async ($, event, next) => {
    if (!(await isActive(wire($)))) {
      return next(event);
    }
    const parentModel = await $.session.model();
    // A built-in agent on a Claude session is Claude's own: no gateway call, ever.
    if (
      event.source === 'built-in' &&
      !isMultiModel(parentModel) &&
      !isProviderWorker(event.agent)
    ) {
      await classify($, event.agent, true);
      return next(event);
    }
    const response = await postJson(wire($), '/multi/mod/offer', {
      sessionId: await $.session.id(),
      cwd: await $.session.cwd(),
      agent: event.agent,
      parentModel,
    });
    await classify($, event.agent, nativeClaude(response));
    // Claude owns its own catalog. Only a positively identified harness worker
    // is subject to Multi's settings-translation compatibility filter.
    const hidden = response?.execution === 'harness' && response.isOffered === false;
    const result = hidden ? { isOffered: false } : await next(event);
    await markOffered($, event.agent, result.isOffered);
    return result;
  });
  on('classic.SubagentStart', async ($, event, next) => {
    if (!(await isActive(wire($)))) {
      return next(event);
    }
    // A native Claude subagent in a Claude session needs no gateway record. The
    // subagent's own model and its parent's are not on this event, so any loop known to
    // run a Multi model (an inheriting child of a provider worker) keeps the record.
    if (
      (await read($, claudeTypes)).includes(event.agent_type) &&
      !isProviderWorker(event.agent_type) &&
      !isMultiModel(await $.session.model()) &&
      !Object.values(await read($, agentModels)).some(isMultiModel)
    ) {
      return next(event);
    }
    const response = await postJson(wire($), '/multi/mod/worker', {
      sessionId: event.session_id,
      agentId: event.agent_id,
      subagentType: event.agent_type,
      cwd: event.cwd,
    });
    const model = response?.accepted ? response.model : undefined;
    if (model) {
      await update($, agentModels, (held) => withBounded(held, event.agent_id, model));
    }
    // Registration is observational for Claude-loop workers. An unregistered
    // harness worker still cannot dispatch: resolveHarness rejects its scope.
    return next(event);
  });
  on('agent.spawn', async ($, event, next) => {
    if (!(await isActive(wire($)))) {
      return next(event);
    }
    // A native Claude subagent runs on Claude Code's own path: no gateway call.
    if (nativeClaudeSpawn(event, await read($, claudeTypes))) {
      return next(event);
    }
    const resolved = await providerSpawn($, event);
    if ('deny' in resolved) {
      return { deny: resolved.deny };
    }
    const spawn = resolved.event;
    const resolvedModel = spawn.model;
    if (resolvedModel && spawn !== event) {
      // Written to state, so the Agent row and the task notification draw the model.
      await update($, spawnModels, (held) => withBounded(held, event.tool_use_id, resolvedModel));
    }
    const denial = await admit($, spawn, resolved.selection);
    if (denial) {
      return { deny: denial };
    }
    const result = await next(spawn);
    const { agentId, model } = result;
    if (agentId && model) {
      await update($, agentModels, (held) => withBounded(held, agentId, model));
    }
    return result;
  });
};

/** Truly native: the gateway classifies the type as Claude-loop and its model is not a Multi one. */
function nativeClaude(response: GatewayResponse | undefined): boolean {
  return response?.execution === 'claude' && !isMultiModel(response.model);
}

/** Remembers whether an agent type is a native Claude subagent, changing state only on a change. */
async function classify($: EngineInterface, agent: string, isNative: boolean) {
  if ((await read($, claudeTypes)).includes(agent) === isNative) {
    return;
  }
  await update($, claudeTypes, (held) =>
    isNative ? withItem(held, agent) : held.filter((type) => type !== agent),
  );
}

/** Tracks the provider worker types the model is offered, for the Agent tool's description. */
async function markOffered($: EngineInterface, agent: string, isOffered: boolean) {
  if (!isProviderWorker(agent) || (await read($, offeredProviders)).includes(agent) === isOffered) {
    return;
  }
  await update($, offeredProviders, (held) =>
    isOffered ? withItem(held, agent) : held.filter((type) => type !== agent),
  );
  $.ui.invalidate('tool.describe');
}

async function spawnPayload($: EngineInterface, event: SpawnEvent) {
  return {
    sessionId: await $.session.id(),
    parentAgentId: event.parentAgentId,
    permissionMode: event.permissionMode,
    subagentType: event.subagentType,
    cwd: event.cwd ?? (await $.session.cwd()),
    model: event.model,
    parentModel: event.parentModel,
    fork: event.fork,
    background: event.background,
  };
}

/**
 * Resolve a provider worker's model: the one its Agent call named, else the provider's
 * default. An unknown or other provider's model refuses the spawn with the gateway's
 * reason, which names the provider's models. Every other spawn keeps its own model.
 */
async function providerSpawn(
  $: EngineInterface,
  event: SpawnEvent,
): Promise<{ deny: string } | { event: SpawnEvent; selection: GatewayResponse | undefined }> {
  const provider = isProviderWorker(event.subagentType) && !event.fork;
  const named = provider ? (requestedModels.get(event.tool_use_id) ?? event.model) : event.model;
  const payload = { ...(await spawnPayload($, event)), model: named };
  const selection = await postJson(wire($), '/multi/mod/worker-model', payload);
  if (!provider) {
    return { event, selection };
  }
  if (!selection) {
    return {
      deny: reportable(`The Multi gateway did not resolve the ${event.subagentType} model.`),
    };
  }
  if (selection.refused || !selection.model) {
    return { deny: selection.error ?? `The ${event.subagentType} model was not resolved.` };
  }
  // The task's description is what the running-agents list and its notification show.
  const description = labelled(event.description, selection.model);
  return { event: { ...event, model: selection.model, description }, selection };
}

/** Admit a harness spawn against the current policy generation; undefined admits it. */
async function admit(
  $: EngineInterface,
  event: SpawnEvent,
  selection: GatewayResponse | undefined,
): Promise<string | undefined> {
  const payload = await spawnPayload($, event);
  if (!harnessSpawn(event, selection)) {
    // Keep context for a possible later harness child, but never veto the
    // engine's native worker because Multi could not reconstruct its policy.
    await postJson(wire($), '/multi/mod/worker', payload);
    return undefined;
  }
  await prepareHarness($);
  // The worker's rows anchor in its own transcript only once their tools exist.
  await syncDisplayTools(rowsClient($));
  const mode = accepted(
    await getJson(wire($), '/multi/mod/mode', { sessionId: payload.sessionId }),
  );
  const response = await postJson(wire($), '/multi/mod/worker', {
    ...payload,
    generation: mode?.generation,
  });
  return response?.accepted
    ? undefined
    : reportable(response?.error ?? 'Multi harness worker policy was not acknowledged.');
}

/**
 * A Claude subagent: not a `multi-*` worker type, classified as native Claude (a Claude
 * model, not a provider model its definition pins), and neither its model nor its
 * parent's (which a fork or an inheriting subagent runs on) is a Multi model.
 */
function nativeClaudeSpawn(event: SpawnEvent, claudeTypeNames: readonly string[]): boolean {
  return (
    claudeTypeNames.includes(event.subagentType) &&
    !isProviderWorker(event.subagentType) &&
    !isMultiModel(event.model) &&
    !isMultiModel(event.parentModel)
  );
}

function harnessSpawn(
  event: { fork?: boolean; model?: string; parentModel?: string },
  selection: GatewayResponse | undefined,
): boolean {
  const inferred = event.fork ? event.parentModel : (event.model ?? event.parentModel);
  return selection?.execution === 'harness' || (!selection?.known && isHarnessModel(inferred));
}

/**
 * Admits the prompt's harness policy once for every helper it spawns. The snapshot is
 * state, so the admission outlives a reload; concurrent helpers share one admission in
 * `policy.ts`.
 */
async function prepareHarness($: EngineInterface) {
  const held = await read($, policy);
  if (!held.prompt || held.harnessReady) {
    return;
  }
  const admitted: MultiCorePolicy = { ...held };
  await ensureHarnessPolicy(policyClient(wire($), await $.session.model()), admitted);
  await update($, policy, (latest) =>
    JSON.stringify(latest.prompt) === JSON.stringify(held.prompt)
      ? defined({ ...latest, generation: admitted.generation, harnessReady: admitted.harnessReady })
      : latest,
  );
}

import type { AgentSpawnInput, EngineInterface, Register } from 'claude-code';
import {
  ensureHarnessPolicy,
  type PolicyClient,
  type PolicyResponse,
  type PolicyState,
} from './policy.ts';
import { isHarnessModel } from './provider.ts';
import { isProviderWorker, labelled, register as registerWorkerRows } from './worker-rows.ts';

const maxBody = 32000;
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

type GatewayResponse = PolicyResponse & {
  accepted?: boolean;
  error?: string;
  isOffered?: boolean;
  execution?: 'claude' | 'harness';
  known?: boolean;
  model?: string;
};

type SpawnEvent = AgentSpawnInput;

/**
 * The model an Agent call named for a provider worker, by tool_use_id. The Agent tool's
 * schema only admits Claude aliases, so `tool.call` (which runs before the engine checks
 * the input) takes the value out and `agent.spawn` resolves it against the catalog.
 */
const requestedModels = new Map<string, string>();

/** Bounded like the other per-call records: the oldest entry makes room. */
export function rememberBounded<T>(entries: Map<string, T>, key: string, value: T, limit = 256) {
  entries.delete(key);
  const oldest = entries.keys().next();
  if (entries.size >= limit && !oldest.done) {
    entries.delete(oldest.value);
  }
  entries.set(key, value);
}

// A refused reply keeps only the reason: a non-2xx status never carries an
// acknowledgement, so every caller still fails closed on the HTTP status alone.
function refusal(text: string, status: number): GatewayResponse {
  let reason: string | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const value = (parsed as { error?: unknown }).error;
      reason = typeof value === 'string' && value ? value : undefined;
    }
  } catch {
    // A non-JSON body still names the status below.
  }
  const detail = text.trim().slice(0, 200);
  return {
    refused: true,
    httpStatus: status,
    error: reason ?? (detail ? `gateway ${status}: ${detail}` : `gateway ${status}`),
  };
}

export const register = (
  on: Parameters<Register>[0],
  _options: Parameters<Register>[1],
  agentModels: Map<string, string> = new Map(),
  policyState: PolicyState = {},
  spawnModels: Map<string, string> = new Map(),
) => {
  /** The resolved model of each provider-worker spawn, by its Agent call's tool_use_id. */
  registerWorkerRows(on, agentModels, spawnModels);
  on('tool.describe', { tool: 'Agent' }, async ($, event, next) => {
    const described = await next(event);
    if (!(await active($))) {
      return described;
    }
    return {
      ...described,
      description: `${described.description}\n\nFor a multi-* agent type (multi-cursor, multi-openai, ...), \`model\` names one of that provider's models from the type's description, not a Claude alias; omit it for the provider's default.`,
    };
  });
  on('tool.call', { tool: 'Agent' }, async ($, event, next) => {
    if (event.tool !== 'Agent' || event.model === undefined) {
      return next(event);
    }
    if (!isProviderWorker(event.subagent_type) || !(await active($))) {
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
    if (!(await active($))) {
      return next(event);
    }
    const response = await request(
      $,
      {
        sessionId: await $.session.id(),
        cwd: await $.session.cwd(),
        agent: event.agent,
        parentModel: await $.session.model(),
      },
      '/multi/mod/offer',
    );
    // Claude owns its own catalog. Only a positively identified harness worker
    // is subject to Multi's settings-translation compatibility filter.
    return response?.execution === 'harness' && response.isOffered === false
      ? { isOffered: false }
      : next(event);
  });
  on('classic.SubagentStart', async ($, event, next) => {
    if (!(await active($))) {
      return next(event);
    }
    const response = await request($, {
      sessionId: event.session_id,
      agentId: event.agent_id,
      subagentType: event.agent_type,
      cwd: event.cwd,
    });
    if (response?.accepted && response.model) {
      agentModels.set(event.agent_id, response.model);
    }
    // Registration is observational for Claude-loop workers. An unregistered
    // harness worker still cannot dispatch: resolveHarness rejects its scope.
    return next(event);
  });
  on('agent.spawn', async ($, event, next) => {
    if (!(await active($))) {
      return next(event);
    }
    const resolved = await providerSpawn($, event);
    if ('deny' in resolved) {
      return { deny: resolved.deny };
    }
    const spawn = resolved.event;
    if (spawn.model && spawn !== event) {
      rememberBounded(spawnModels, event.tool_use_id, spawn.model);
      $.ui.invalidate('ui.render');
    }
    const denial = await admit($, spawn, resolved.selection, policyState);
    if (denial) {
      return { deny: denial };
    }
    const result = await next(spawn);
    if (result.agentId && result.model) {
      agentModels.set(result.agentId, result.model);
    }
    return result;
  });
};

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
  const selection = await request($, payload, '/multi/mod/worker-model');
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
  policyState: PolicyState,
): Promise<string | undefined> {
  const payload = await spawnPayload($, event);
  if (!harnessSpawn(event, selection)) {
    // Keep context for a possible later harness child, but never veto the
    // engine's native worker because Multi could not reconstruct its policy.
    await request($, payload);
    return undefined;
  }
  await prepareHarness($, policyState);
  const mode = await request(
    $,
    {},
    `/multi/mod/mode?sessionId=${encodeURIComponent(payload.sessionId)}`,
  );
  const response = await request($, { ...payload, generation: mode?.generation });
  return response?.accepted
    ? undefined
    : reportable(response?.error ?? 'Multi harness worker policy was not acknowledged.');
}

function harnessSpawn(
  event: { fork?: boolean; model?: string; parentModel?: string },
  selection: GatewayResponse | undefined,
): boolean {
  const inferred = event.fork ? event.parentModel : (event.model ?? event.parentModel);
  return selection?.execution === 'harness' || (!selection?.known && isHarnessModel(inferred));
}

async function active($: EngineInterface): Promise<boolean> {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  return Boolean(base && token);
}

async function request(
  $: EngineInterface,
  payload: Record<string, unknown>,
  route = '/multi/mod/worker',
) {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  if (!base || !token) {
    return undefined;
  }
  const body = JSON.stringify(payload);
  if (encodeURIComponent(body).replace(/%[A-F\d]{2}/gi, 'x').length > maxBody) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = $.http.fetch(`${base}${route}`, {
      method: route.includes('?') ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
      ...(route.includes('?') ? {} : { body }),
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('gateway request timeout')), 1500);
    });
    const result = await Promise.race([response, timeout]);
    return result.ok
      ? (JSON.parse(result.text) as GatewayResponse)
      : refusal(result.text, result.status);
  } catch {
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function policyClient($: EngineInterface): Promise<PolicyClient> {
  return {
    model: await $.session.model(),
    request: (route, payload) => request($, payload, route),
  };
}

async function prepareHarness($: EngineInterface, state: PolicyState) {
  if (state.prompt && !state.harnessReady) {
    await ensureHarnessPolicy(await policyClient($), state);
  }
}

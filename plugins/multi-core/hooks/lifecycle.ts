import type { EngineInterface, Register, TurnStepInputChunk } from 'claude-code';
import { isHarnessModel } from './provider.ts';
import { type RowsClient, syncDisplayTools } from './rows.ts';
import { forgetUsageSession } from './usage.ts';
import { appendLabel, providerName, workerLabel } from './worker-rows.ts';

type Status = {
  model?: string;
  state?: string;
  detail?: string;
  error?: string;
  elapsedMs?: number;
  startedAt?: number;
};

function rememberBounded<T>(entries: Map<string, T>, key: string, value: T, limit = 256) {
  entries.delete(key);
  const oldest = entries.keys().next();
  if (entries.size >= limit && !oldest.done) {
    entries.delete(oldest.value);
  }
  entries.set(key, value);
}

async function resolveWorkerModel(
  $: EngineInterface,
  subagentType: string,
  model: string | undefined,
  parentModel: string,
  agentId?: string,
): Promise<string | undefined> {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  if (!base || !token) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const payload = {
      sessionId: await $.session.id(),
      parentAgentId: agentId,
      subagentType,
      cwd: await $.session.cwd(),
      model,
      parentModel,
    };
    const response = await Promise.race([
      $.http.fetch(`${base}/multi/mod/worker-model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
        body: JSON.stringify(payload),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('gateway timeout')), 1500);
      }),
    ]);
    if (!response.ok) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(response.text);
    if (!parsed || typeof parsed !== 'object' || (parsed as { refused?: boolean }).refused) {
      return undefined;
    }
    const resolved = (parsed as { model?: unknown }).model;
    if (typeof resolved === 'string') {
      return resolved;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function rewriteAgentInput(
  $: EngineInterface,
  chunk: TurnStepInputChunk,
  parentModel: string,
  agentId: string | undefined,
  toolUseId: string | undefined,
  spawnModels: Map<string, string>,
): Promise<TurnStepInputChunk> {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(chunk.json);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    return chunk;
  }
  if (
    !parsed ||
    typeof parsed.subagent_type !== 'string' ||
    !parsed.subagent_type.startsWith('multi-')
  ) {
    return chunk;
  }
  const explicitModel = typeof parsed.model === 'string' ? parsed.model : undefined;
  const resolvedModel = await resolveWorkerModel(
    $,
    parsed.subagent_type,
    explicitModel,
    parentModel,
    agentId,
  );
  if (resolvedModel && toolUseId) {
    rememberBounded(spawnModels, toolUseId, resolvedModel);
  }
  const label =
    (resolvedModel ? workerLabel(resolvedModel) : undefined) ?? providerName(parsed.subagent_type);
  if (!label || typeof parsed.description !== 'string') {
    return chunk;
  }
  const description = appendLabel(parsed.description, label);
  return {
    ...chunk,
    json: JSON.stringify({ ...parsed, description }),
  };
}

async function prepareStep(
  $: EngineInterface,
  event: { agentId?: string; model: string },
  models: Map<string, string>,
  running: Map<string, object>,
) {
  const key = event.agentId ?? 'main';
  models.set(key, event.model);
  const native = isHarnessModel(event.model);
  if (native && !running.has(key) && running.size < 128) {
    const token = {};
    running.set(key, token);
    void poll($, event.agentId, () => running.get(key) === token);
  }
  void postStep($, event);
  if (native) {
    // A harness may announce a tool the mod has not registered; register it
    // before the step's request, so the rows of later runs can anchor.
    await syncDisplayTools(rowsClient($));
  }
}

export const register = (
  on: Parameters<Register>[0],
  _options: Parameters<Register>[1],
  onDetach: () => void = () => {},
  models: Map<string, string> = new Map(),
  spawnModels: Map<string, string> = new Map(),
) => {
  const running = new Map<string, object>();
  on('turn.step', async function* ($, event, next) {
    await prepareStep($, event, models, running);
    const agentCalls = new Map<number, string>();
    for await (const chunk of next(event)) {
      if (chunk.kind === 'tool') {
        if (chunk.name === 'Agent') {
          agentCalls.set(chunk.index, chunk.id);
        }
        yield chunk;
        continue;
      }
      if (chunk.kind === 'input' && agentCalls.has(chunk.index)) {
        const rewritten = await rewriteAgentInput(
          $,
          chunk,
          event.model,
          event.agentId,
          agentCalls.get(chunk.index),
          spawnModels,
        );
        yield rewritten;
        continue;
      }
      yield chunk;
    }
  });
  on('turn.complete', async ($, event, next) => {
    const key = event.agentId ?? 'main';
    const model = models.get(key);
    if (model?.startsWith('multi/')) {
      await request($, '/multi/mod/usage/complete', {
        sessionId: await $.session.id(),
        agentId: event.agentId,
        turnId: event.turnId,
        outcome: event.reason,
      });
    }
    const wasRunning = running.delete(key);
    // Retain a child's identity between turns: compaction can precede its next step.
    if (event.isAborted && isHarnessModel(model)) {
      void cancelCompaction($, event.agentId);
    }
    if (wasRunning && running.size === 0) {
      void $.ui.status(undefined);
    }
    return next(event);
  });
  on('session.detach', async ($, event, next) => {
    onDetach();
    forgetUsageSession(await $.session.id());
    running.clear();
    models.clear();
    void detach($);
    return next(event);
  });
};

function rowsClient($: EngineInterface): RowsClient {
  return {
    sessionId: () => $.session.id(),
    catalog: () => request($, '/multi/mod/display-tools'),
    register: (tool) => $.tool.register(tool),
    acknowledge: (payload) => request($, '/multi/mod/display-tools', payload),
  };
}

async function postStep($: EngineInterface, event: object) {
  await request($, '/multi/mod/telemetry', { ...event, sessionId: await $.session.id() });
}

async function detach($: EngineInterface) {
  await request($, '/multi/mod/detach', { sessionId: await $.session.id() });
}

async function poll($: EngineInterface, agentId: string | undefined, active: () => boolean) {
  const since = Date.now();
  const sessionId = await $.session.id();
  const query = `sessionId=${encodeURIComponent(sessionId)}&agentId=${encodeURIComponent(agentId ?? 'main')}`;
  let failures = 0;
  while (active() && failures < 5) {
    const status = await request($, `/multi/mod/lifecycle?${query}`);
    if (!active()) {
      return;
    }
    failures = status ? 0 : failures + 1;
    if (status?.state && (status.startedAt ?? 0) >= since) {
      await $.ui.status(statusText(status, agentId));
      if (status.state !== 'running') {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function request(
  $: EngineInterface,
  route: string,
  payload?: object,
): Promise<Status | undefined> {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  if (!base || !token) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      $.http.fetch(`${base}${route}`, {
        method: payload ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Gateway timeout')), 1500);
      }),
    ]);
    return response.ok ? (JSON.parse(response.text) as Status) : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function statusText(status: Status, agentId: string | undefined) {
  const elapsed = Math.floor((status.elapsedMs ?? 0) / 1000);
  // A failed or refused run names its reason, so the line says why, not only that.
  return `${status.model} · ${agentId ?? 'main'} · ${status.state} · ${elapsed}s ${status.error ?? status.detail ?? ''}`;
}
async function cancelCompaction($: EngineInterface, agentId?: string) {
  await request($, '/multi/mod/compact/cancel', { sessionId: await $.session.id(), agentId });
}

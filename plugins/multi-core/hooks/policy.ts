import type { MultiCorePolicy, MultiCorePrompt } from '../types/multi-core.d.ts';
import { type GatewayOptions, getJson, postJson, type Wire } from './gateway.ts';
import { isHarnessModel } from './provider.ts';

export type PolicyResponse = {
  refused?: true;
  httpStatus?: number;
  error?: string;
  generation?: number | string;
  status?: string;
  accepted?: boolean;
};
/** The policy's gateway for one session model; `wire` is the calling file's own. */
export function policyClient(wire: Wire, model: string): PolicyClient {
  return {
    model,
    post: (route, payload, options) => postJson(wire, route, payload, options),
    get: (route, query) => getJson(wire, route, query),
  };
}

/** The gateway as the policy needs it: explicit methods, as `gateway.ts` offers them. */
export type PolicyClient = {
  model: string;
  post: (
    route: string,
    payload: Record<string, unknown>,
    options?: GatewayOptions,
  ) => Promise<PolicyResponse | undefined>;
  get: (route: string, query: Record<string, string>) => Promise<PolicyResponse | undefined>;
};
export type PromptSnapshot = MultiCorePrompt;
export type PolicyState = MultiCorePolicy;

/** The admission each prompt is running, shared by every helper spawned from that prompt. */
const preparing = new Map<string, Promise<number | undefined>>();

/** A prompt's identity as the gateway holds it: what, with the model, decides a repost. */
export function snapshotKey(snapshot: PromptSnapshot, model: string): string {
  return JSON.stringify([snapshot.sessionId, snapshot.cwd, snapshot.permissionMode ?? null, model]);
}

/**
 * Share one admission across helpers spawned from the same prompt. It updates `state`,
 * a copy the caller persists; only a state still holding the admitted prompt is changed.
 */
export async function ensureHarnessPolicy(client: PolicyClient, state: PolicyState) {
  const snapshot = state.prompt;
  if (!snapshot || state.harnessReady) {
    return;
  }
  const key = snapshotKey(snapshot, client.model);
  const admission = preparing.get(key) ?? admitPrompt(client, snapshot, state.generation);
  preparing.set(key, admission);
  let generation: number | undefined;
  try {
    generation = await admission;
  } finally {
    if (preparing.get(key) === admission) {
      preparing.delete(key);
    }
  }
  state.generation = generation;
  state.harnessReady = generation !== undefined;
}

/** Prepare translated settings only for a harness prompt or a requested harness worker. */
export async function admitPrompt(
  client: PolicyClient,
  snapshot: PromptSnapshot,
  sourceGeneration: number | undefined,
): Promise<number | undefined> {
  const prepared = await preparePolicy(client, snapshot.sessionId, snapshot.cwd, sourceGeneration);
  if (!prepared) {
    return undefined;
  }
  const response = await client.post('/multi/mod/session', {
    policyGeneration: prepared.policyGeneration,
    sessionId: snapshot.sessionId,
    cwd: snapshot.cwd,
    model: client.model,
    event: 'prompt',
    generation: prepared.generation,
    permissionMode: snapshot.permissionMode,
  });
  if (!response?.accepted || typeof response.generation !== 'number') {
    return undefined;
  }
  return response.generation;
}

/** Only an actual harness prompt waits for translated settings policy. */
export async function recordPrompt(
  client: PolicyClient,
  snapshot: PromptSnapshot,
  generation: number | undefined,
): Promise<number | undefined> {
  const model = client.model;
  if (isHarnessModel(model)) {
    return admitPrompt(client, snapshot, generation);
  }
  const response = await client.post('/multi/mod/session', {
    ...snapshot,
    model,
    event: 'prompt',
  });
  return response?.accepted && typeof response.generation === 'number'
    ? response.generation
    : undefined;
}

type PolicyHandoff = { policyGeneration: string; generation: number | undefined };

/** Exported for offline coverage of the stale-generation resync. */
export async function preparePolicy(
  client: PolicyClient,
  sessionId: string,
  cwd: string,
  sourceGeneration: number | undefined,
): Promise<PolicyHandoff | undefined> {
  let generation = sourceGeneration;
  let started = await client.post('/multi/mod/policy', { sessionId, cwd, sourceGeneration });
  if (started?.refused) {
    // A reloaded hooks module keeps a mode generation the gateway no longer agrees
    // with, and `/clear` detaches the session so the gateway holds none at all;
    // either way every later prompt reads stale. Adopt the gateway's own value once,
    // including the absence of one, which begins a fresh session.
    const resynced = await modeGeneration(client, sessionId);
    if (!resynced || resynced.generation === generation) {
      return undefined;
    }
    generation = resynced.generation;
    started = await client.post('/multi/mod/policy', {
      sessionId,
      cwd,
      sourceGeneration: generation,
    });
  }
  if (started?.refused || typeof started?.generation !== 'string') {
    return undefined;
  }
  const policyGeneration = await awaitPolicy(client, sessionId, started.generation);
  return policyGeneration === undefined ? undefined : { policyGeneration, generation };
}

/**
 * One request: the gateway holds the reply until discovery ends (`claude plugin list`
 * and settings admission take seconds on a cold Windows start) or its own bound passes.
 * The wait is the gateway's, so it needs no polling loop in the hook's budget.
 */
async function awaitPolicy(client: PolicyClient, sessionId: string, generation: string) {
  const result = await client.post(
    '/multi/mod/policy',
    { sessionId, generation, wait: true },
    { timeoutMs: 0 },
  );
  return result?.status === 'ready' && !result.refused ? generation : undefined;
}

/** The gateway's own mode generation, or `{ generation: undefined }` when it holds none. */
async function modeGeneration(client: PolicyClient, sessionId: string) {
  const mode = await client.get('/multi/mod/mode', { sessionId });
  if (typeof mode?.generation === 'number') {
    return { generation: mode.generation };
  }
  // A 409 is the gateway answering that it holds no mode for this session, as after
  // `/clear` detaches it. An unreachable gateway leaves the truth unknown instead.
  if (mode && (!mode.refused || mode.httpStatus === 409)) {
    return { generation: undefined };
  }
  return undefined;
}

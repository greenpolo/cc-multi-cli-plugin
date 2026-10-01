import { expect, test } from 'claude-code/testing';
import {
  admitPrompt,
  ensureHarnessPolicy,
  type PolicyClient,
  type PolicyState,
  preparePolicy,
  recordPrompt,
} from '../policy.ts';

type Call = { url: string; body: Record<string, unknown> };

/** The HTTP adapter has already parsed success and refusal replies. */
function gateway(held: number | undefined, calls: Call[]): PolicyClient {
  return {
    model: 'multi/cursor/auto',
    get: async (route, query) => {
      calls.push({ url: `${route}?${new URLSearchParams(query)}`, body: {} });
      return held === undefined ? { refused: true, httpStatus: 409 } : { generation: held };
    },
    post: async (route, body) => {
      calls.push({ url: route, body });
      if (route === '/multi/mod/session') {
        return { accepted: true, generation: 11 };
      }
      if (typeof body.generation === 'string') {
        // One held request: the gateway answers once discovery has ended.
        expect(body.wait).toBe(true);
        return { generation: body.generation, status: 'ready' };
      }
      if (body.sourceGeneration !== held) {
        return { refused: true, httpStatus: 400, error: 'Policy source generation is stale' };
      }
      return { generation: 'policy-1', status: 'pending' };
    },
  };
}
function unreachable(): PolicyClient {
  return {
    model: 'multi/cursor/auto',
    get: async () => undefined,
    post: async () => undefined,
  };
}

test('concurrent harness helpers share admission and later helpers reuse it', async () => {
  const calls: Call[] = [];
  const client = gateway(undefined, calls);
  const state: PolicyState = {
    prompt: { sessionId: 'session', cwd: '/workspace', permissionMode: 'plan' },
  };
  await Promise.all([ensureHarnessPolicy(client, state), ensureHarnessPolicy(client, state)]);
  await ensureHarnessPolicy(client, state);
  expect(calls.filter((call) => call.url === '/multi/mod/session').length).toBe(1);
  expect(state.harnessReady).toBe(true);
  expect(state.generation).toBe(11);
});

test('a reloaded hooks module adopts the mode generation the gateway still holds', async () => {
  const calls: Call[] = [];
  const prepared = await preparePolicy(gateway(7, calls), 'session', '/workspace', undefined);
  expect(prepared).toEqual({ policyGeneration: 'policy-1', generation: 7 });
  expect(calls.some((call) => call.url.startsWith('/multi/mod/mode?'))).toBe(true);
});

test('a detached session adopts the absence of a generation instead of blocking forever', async () => {
  const calls: Call[] = [];
  const prepared = await preparePolicy(gateway(undefined, calls), 'session', '/workspace', 3);
  expect(prepared).toEqual({ policyGeneration: 'policy-1', generation: undefined });
  const begins = calls.filter((call) => call.url === '/multi/mod/policy' && !call.body.generation);
  expect(begins.at(-1)?.body.sourceGeneration).toBe(undefined);
});

test('policy admission still fails when the gateway answers nothing to adopt', async () => {
  expect(await preparePolicy(unreachable(), 'session', '/workspace', 3)).toBe(undefined);
});

test('a matching source generation never re-reads the gateway mode', async () => {
  const calls: Call[] = [];
  const prepared = await preparePolicy(gateway(4, calls), 'session', '/workspace', 4);
  expect(prepared).toEqual({ policyGeneration: 'policy-1', generation: 4 });
  expect(calls.some((call) => call.url.startsWith('/multi/mod/mode?'))).toBe(false);
});

test('a session that already holds no generation is not resynced in a loop', async () => {
  const calls: Call[] = [];
  expect(
    await preparePolicy(gateway(undefined, calls), 'session', '/workspace', undefined),
  ).toEqual({ policyGeneration: 'policy-1', generation: undefined });
  expect(calls.some((call) => call.url.startsWith('/multi/mod/mode?'))).toBe(false);
});

test('a prompt whose policy cannot be admitted carries no generation and is never blocked', async () => {
  const calls: Call[] = [];
  const snapshot = { sessionId: 'session', cwd: '/workspace', permissionMode: 'default' };
  // The mode route answers nothing, so no generation can be adopted or recorded.
  expect(await admitPrompt(unreachable(), snapshot, 3)).toBe(undefined);
  // A detached session recovers on its own and records the new snapshot.
  expect(await admitPrompt(gateway(undefined, calls), snapshot, 3)).toBe(11);
  expect(calls.some((call) => call.url === '/multi/mod/session')).toBe(true);
});

for (const model of ['claude-sonnet-5', 'multi/openai/gpt-6-astra', 'multi/zen/glm-5']) {
  test(`${model} prompts record identity without preparing harness policy`, async () => {
    const calls: Call[] = [];
    const client = { ...gateway(undefined, calls), model };
    const snapshot = { sessionId: 'session', cwd: '/workspace', permissionMode: 'plan' };
    expect(await recordPrompt(client, snapshot, 7)).toBe(11);
    expect(calls.map((call) => call.url)).toEqual(['/multi/mod/session']);
    expect(calls[0]?.body.policyGeneration).toBe(undefined);
    expect(calls[0]?.body.permissionMode).toBe('plan');
  });
}

test('policy readiness is one held request rather than a polling loop', async () => {
  const calls: Call[] = [];
  await preparePolicy(gateway(undefined, calls), 'session', '/workspace', undefined);
  const waits = calls.filter((call) => call.body.wait === true);
  expect(waits.length).toBe(1);
  expect(waits[0]?.body.generation).toBe('policy-1');
});

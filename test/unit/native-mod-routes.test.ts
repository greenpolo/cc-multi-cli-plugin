import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ModBridge } from '../../plugins/multi-core/src/gateway/mod-bridge.ts';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';

async function start(
  t: test.TestContext,
  permissionModes?: PermissionModes,
  antigravity?: Parameters<typeof createNativeGateway>[0]['antigravity'],
  guardAuto?: boolean,
) {
  const server = createNativeGateway({
    token: 'mod-token',
    authFile: 'unused',
    permissionModes,
    antigravity,
    guardAuto,
    modBridge: new ModBridge(),
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function request(
  base: string,
  route: string,
  body?: unknown,
  method = 'POST',
  token = 'mod-token',
) {
  const response = await fetch(base + route, {
    method,
    headers: { 'x-multi-gateway-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed as Record<string, unknown> };
}

test('mod mode snapshots acknowledge generations and reject stale updates', async (t) => {
  const base = await start(t);
  const first = await request(base, '/multi/mod/session', {
    sessionId: 's',
    permissionMode: 'plan',
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.accepted, true);
  const stale = await request(base, '/multi/mod/session', {
    sessionId: 's',
    permissionMode: 'bypassPermissions',
    generation: 999,
  });
  assert.equal(stale.status, 409);
  const mode = await request(base, '/multi/mod/mode?sessionId=s', undefined, 'GET');
  assert.deepEqual(mode.body.effective, { permissionMode: 'plan' });
});

test('mod routes reject unauthenticated requests', async (t) => {
  const base = await start(t);
  const response = await fetch(`${base}/multi/mod/mode?sessionId=s`);
  assert.equal(response.status, 401);
});

test('PermissionModes refuses native resolution until an acknowledged prompt snapshot', () => {
  const modes = new PermissionModes(async () => ({}));
  assert.throws(() => modes.resolve('missing'), /permission mode is unavailable/);
  modes.recordModSession('session', { permissionMode: 'plan', cwd: '/tmp' });
  assert.equal(modes.resolve('session').permissionMode, 'plan');
});

test('permission observations neither prepare settings nor grant harness admission', async (t) => {
  let discoveries = 0;
  const modes = new PermissionModes(async () => {
    discoveries++;
    return {};
  });
  const base = await start(t, modes, undefined, true);
  const response = await request(base, '/multi/permission', {
    hook_event_name: 'PreToolUse',
    session_id: 'native',
    cwd: '/workspace',
    permission_mode: 'plan',
    tool_name: 'Read',
    tool_use_id: 'tool-1',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {});
  assert.equal(discoveries, 0);
  assert.throws(() => modes.resolveHarness('native'), /unavailable/);
});

test('Claude-loop worker route does not require a settings-policy generation', async (t) => {
  const modes = new PermissionModes(async () => ({
    worker: { model: 'multi/zen/deepseek-v4-pro' },
  }));
  await modes.precompute('/workspace');
  modes.recordHostSession('session', {
    permissionMode: 'default',
    cwd: '/workspace',
    model: 'multi/openai/gpt-6-luna',
  });
  const base = await start(t, modes);
  const result = await request(base, '/multi/mod/worker', {
    sessionId: 'session',
    subagentType: 'worker',
    cwd: '/workspace',
    permissionMode: 'default',
    model: 'multi/zen/deepseek-v4-pro',
    parentModel: 'multi/openai/gpt-6-luna',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.accepted, true);
});

test('PermissionModes retains a tool-free compaction boundary and acknowledges workers', async () => {
  const modes = new PermissionModes(async () => ({
    cursor: {
      permissionMode: 'plan',
      tools: ['Read'],
      disallowedTools: ['Bash'],
    },
  }));
  await modes.precompute('/workspace');
  modes.recordModSession('session', { permissionMode: 'auto', cwd: '/workspace' });
  modes.authorizeModCompaction('session');
  const compact = modes.resolve('session');
  assert.equal(compact.permissionMode, 'auto');
  assert.equal(typeof compact.compaction, 'string');
  const workerToken = await modes.prepareModWorker('session', {
    subagentType: 'cursor',
    permissionMode: 'auto',
    cwd: '/workspace',
  });
  modes.recordPreparedModWorker('session', 'worker', workerToken);
  assert.deepEqual(modes.resolve('session', 'worker').disallowedTools, ['Bash']);
  assert.throws(
    () => modes.recordPreparedModWorker('session', 'other', workerToken),
    /Worker policy acknowledgement is unavailable/,
  );
});

test('compaction authorization accepts a restored bridge generation without a prompt snapshot', async (t) => {
  const modes = new PermissionModes(async () => ({}));
  const base = await start(t, modes);
  const started = await request(base, '/multi/mod/session', {
    sessionId: 'resumed',
    event: 'start',
    cwd: '/workspace',
  });
  assert.equal(started.status, 200);
  const result = await request(base, '/multi/mod/compact/authorize', {
    sessionId: 'resumed',
    generation: started.body.generation,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.allow, true);
  assert.deepEqual(modes.resolve('resumed').tools, []);
  assert.throws(() => modes.resolve('resumed', 'unknown'), /worker/i);
});

test('mod requests have a control-plane byte limit and reject malformed restrictions', async (t) => {
  const base = await start(t);
  const oversized = await fetch(`${base}/multi/mod/session`, {
    method: 'POST',
    headers: { 'x-multi-gateway-token': 'mod-token' },
    body: JSON.stringify({ sessionId: 's', text: 'x'.repeat(33000) }),
  });
  assert.equal(oversized.status, 413);
  for (const tools of [['Read', 1], ['x'.repeat(513)], 'Read']) {
    const result = await request(base, '/multi/mod/session', {
      sessionId: 's',
      permissionMode: 'plan',
      tools,
    });
    assert.equal(result.status, 400);
  }
});

test('mod routes reject browser origins, invalid methods and invalid worker identities', async (t) => {
  const base = await start(t);
  const browser = await fetch(`${base}/multi/mod/mode?sessionId=s`, {
    headers: { origin: 'https://example.com', 'x-multi-gateway-token': 'mod-token' },
  });
  assert.equal(browser.status, 401);
  assert.equal((await request(base, '/multi/mod/session', undefined, 'GET')).status, 400);
  assert.equal(
    (await request(base, '/multi/mod/session', { sessionId: 's', agentId: 3 })).status,
    400,
  );
});

test('display observations retain only bounded pending actions and lifecycle state', () => {
  const bridge = new ModBridge();
  const key = JSON.stringify(['s', 'worker']);
  bridge.begin(key, 'multi/cursor/auto');
  bridge.observe(key, { type: 'started', id: 'row', kind: 'read', description: 'file' });
  assert.equal(bridge.status(key)?.detail, 'file');
  const row = bridge.observe(key, { type: 'completed', id: 'row', text: 'result', error: false });
  assert.equal(row?.input.output, 'result');
  assert.equal(
    bridge.observe(key, { type: 'completed', id: 'row', text: 'replay', error: false }),
    undefined,
  );
  bridge.complete(key, 'cancelled');
  assert.equal(bridge.status(key)?.state, 'cancelled');
  bridge.forgetSession('s');
  assert.equal(bridge.status(key), undefined);
});

async function admit(base: string) {
  const initial = await request(base, '/multi/mod/session', {
    sessionId: 's',
    event: 'start',
    cwd: '/workspace',
  });
  const policy = await request(base, '/multi/mod/policy', {
    sessionId: 's',
    cwd: '/workspace',
    sourceGeneration: initial.body.generation,
  });
  await setImmediate();
  const prompt = await request(base, '/multi/mod/session', {
    sessionId: 's',
    event: 'prompt',
    cwd: '/workspace',
    permissionMode: 'bypassPermissions',
    model: 'multi/antigravity/model',
    generation: initial.body.generation,
    policyGeneration: policy.body.generation,
  });
  assert.equal(prompt.status, 200);
  return prompt.body.generation;
}

test('compaction core fallback authenticates generation and removes all native capabilities', async (t) => {
  const modes = new PermissionModes(async () => ({}));
  const base = await start(t, modes);
  const generation = await admit(base);
  const stale = await request(base, '/multi/mod/compact/authorize', {
    sessionId: 's',
    generation: -1,
  });
  assert.equal(stale.status, 400);
  assert.equal(modes.resolve('s').compaction, undefined);
  const accepted = await request(base, '/multi/mod/compact/authorize', {
    sessionId: 's',
    generation,
  });
  assert.equal(accepted.body.allow, true);
  assert.deepEqual(modes.resolve('s').tools, []);
  assert.equal(typeof modes.resolve('s').compaction, 'string');
});

test('worker route authenticates catalog and generation before child-start acknowledgement', async (t) => {
  const modes = new PermissionModes(async () => ({
    worker: { model: 'multi/cursor/auto', tools: ['Read'] },
  }));
  const base = await start(t, modes);
  const generation = await admit(base);
  const spawn = {
    sessionId: 's',
    cwd: '/workspace',
    generation,
    parentModel: 'multi/antigravity/model',
    permissionMode: 'bypassPermissions',
    subagentType: 'worker',
  };
  assert.equal(
    (await request(base, '/multi/mod/worker', { ...spawn, generation: -1 })).status,
    400,
  );
  assert.equal(
    (await request(base, '/multi/mod/worker', { ...spawn, model: 'wrong' })).status,
    400,
  );
  assert.equal((await request(base, '/multi/mod/worker', spawn)).body.accepted, true);
  assert.throws(() => modes.resolve('s', 'child'), /unavailable/);
  assert.equal(
    (
      await request(base, '/multi/mod/worker', {
        sessionId: 's',
        agentId: 'child',
        cwd: '/workspace',
        subagentType: 'worker',
      })
    ).body.accepted,
    true,
  );
  assert.deepEqual(modes.resolve('s', 'child').tools, ['Read']);
});

test('model effort telemetry is scoped observation and cannot change policy', async (t) => {
  const modes = new PermissionModes(async () => ({}));
  const base = await start(t, modes);
  await admit(base);
  const before = modes.resolve('s');
  await request(base, '/multi/mod/telemetry', {
    sessionId: 's',
    agentId: 'worker',
    model: 'multi/openai/gpt-6-astra',
    effort: 'high',
    permissionMode: 'plan',
  });
  const telemetry = await request(
    base,
    '/multi/mod/telemetry?sessionId=s&agentId=worker',
    undefined,
    'GET',
  );
  assert.deepEqual(telemetry.body, { model: 'multi/openai/gpt-6-astra', effort: 'high' });
  assert.deepEqual(modes.resolve('s'), before);
});

test('two-phase compaction invokes the native fixture once without tools or origin-state mutation', async (t) => {
  const modes = new PermissionModes(async () => ({}));
  let calls = 0;
  const base = await start(t, modes, {
    validate: () => 1,
    handle: async (_body, scope, _signal, _emit, context) => {
      calls++;
      assert.deepEqual(context?.tools, []);
      assert.equal(typeof context?.compaction, 'string');
      assert.match(scope, /compact-/);
      return {
        id: 'summary',
        type: 'message',
        role: 'assistant',
        model: 'multi/antigravity/model',
        content: [{ type: 'text', text: 'fixture summary' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  });
  const generation = await admit(base);
  const payload = {
    sessionId: 's',
    generation,
    messages: [{ role: 'user', text: 'task', toolUses: [], handle: 'one' }],
  };
  const prepared = await request(base, '/multi/mod/compact/precompute', payload);
  assert.equal(calls, 0);
  const run = { sessionId: 's', generation, precomputeId: prepared.body.precomputeId };
  assert.equal((await request(base, '/multi/mod/compact/run', run)).body.accepted, true);
  await setImmediate();
  await request(base, '/multi/mod/compact/run', run);
  const result = await request(base, '/multi/mod/compact/authorize', payload);
  assert.deepEqual(result.body.messages, [
    { role: 'user', text: 'Conversation summary:\nfixture summary', toolUses: [] },
  ]);
  assert.equal(calls, 1);
  assert.equal(
    modes.resolve('s').compaction,
    undefined,
    'ready summary does not poison normal dispatch',
  );
});

test('a prompt snapshot without a permission mode admits no policy but never blocks', async (t) => {
  const modes = new PermissionModes(async () => ({}));
  const base = await start(t, modes);
  const accepted = await request(base, '/multi/mod/session', {
    sessionId: 'prompt',
    event: 'prompt',
    cwd: '/workspace',
    policyGeneration: 'policy-1',
  });
  // The prompt is never refused over a missing mode; the user keeps working.
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.accepted, true);
  // No mode means no admitted policy: the next tool call recovers it instead.
  assert.throws(() => modes.resolve('prompt'), /permission mode is unavailable/i);
});

test('a session start snapshot still records without carrying a permission mode', async (t) => {
  const modes = new PermissionModes(async () => ({}));
  const base = await start(t, modes);
  const started = await request(base, '/multi/mod/session', {
    sessionId: 'start-only',
    event: 'start',
    cwd: '/workspace',
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.accepted, true);
});

test('wrong tokens cannot update sessions, acknowledge workers, or authorize compaction', async (t) => {
  const modes = new PermissionModes(async () => ({ worker: { model: 'multi/cursor/auto' } }));
  await modes.precompute('/workspace');
  const base = await start(t, modes);
  const rejectedSession = await request(
    base,
    '/multi/mod/session',
    { sessionId: 'unauthorized', event: 'start', cwd: '/workspace' },
    'POST',
    'wrong-token',
  );
  assert.equal(rejectedSession.status, 401);
  assert.throws(() => modes.resolve('unauthorized'), /unavailable/);

  const rejectedWorker = await request(
    base,
    '/multi/mod/worker',
    { sessionId: 'unauthorized', agentId: 'child', subagentType: 'worker', cwd: '/workspace' },
    'POST',
    'wrong-token',
  );
  assert.equal(rejectedWorker.status, 401);
  assert.throws(() => modes.resolve('unauthorized', 'child'), /unavailable/);

  const rejectedCompaction = await request(
    base,
    '/multi/mod/compact/authorize',
    { sessionId: 'unauthorized', generation: 1 },
    'POST',
    'wrong-token',
  );
  assert.equal(rejectedCompaction.status, 401);
  assert.throws(() => modes.resolve('unauthorized'), /unavailable/);
});

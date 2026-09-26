import assert from 'node:assert/strict';
import test from 'node:test';
import { isHarnessModel } from '../../plugins/multi-core/hooks/provider.ts';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import { workerCatalog, workerDefinitions } from '../../plugins/multi-core/src/launcher.ts';
import type { GrokModel } from '../../plugins/multi-grok/src/models.ts';

const model: GrokModel = {
  id: 'grok-4.6',
  model: 'multi/grok/grok-4.6',
  label: 'Grok 4.6',
  default: true,
};

const reply: MessagesResponse = {
  id: 'grok-test',
  type: 'message',
  role: 'assistant',
  model: model.model,
  content: [{ type: 'text', text: '[Grok] run_terminal_command' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100 },
};

async function gateway(t: test.TestContext, handle: Parameters<typeof createNativeGateway>[0]) {
  const server = createNativeGateway(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return (pathname: string) =>
    fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      method: 'POST',
      headers: {
        'x-multi-gateway-token': 'test-token',
        'x-claude-code-session-id': 'test-session',
      },
      body: JSON.stringify({
        model: model.model,
        messages: [{ role: 'user', content: 'run the tests' }],
      }),
    });
}

async function modes() {
  const value = new PermissionModes(async () => ({}));
  await value.record({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'test-session',
    permission_mode: 'auto',
    prompt: 'run the tests',
  });
  return value;
}

test('Grok routing reaches its harness with the session permission mode', async (t) => {
  let calls = 0;
  const request = await gateway(t, {
    token: 'test-token',
    authFile: '/unused',
    permissionModes: await modes(),
    grok: {
      validate: () => 10,
      handle: async (_body, scope, _signal, _emit, context) => {
        assert.equal(context?.permissionMode, 'auto');
        assert.match(scope, /test-session/);
        calls++;
        return reply;
      },
    },
    fetchImpl: async () => {
      throw new Error('A native Grok run must never become a direct provider request');
    },
  });

  const response = await request('/v1/messages');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), reply);
  assert.equal(calls, 1);

  const count = await request('/v1/messages/count_tokens');
  assert.equal(count.headers.get('x-multi-token-count'), 'estimate');
  assert.deepEqual(await count.json(), { input_tokens: 10 });
  assert.equal(calls, 1);
});

test('a Grok route without a configured harness fails as a bad request', async (t) => {
  const request = await gateway(t, {
    token: 'test-token',
    authFile: '/unused',
    permissionModes: await modes(),
    fetchImpl: async () => {
      throw new Error('A missing harness must not fall back to an HTTP provider');
    },
  });

  const response = await request('/v1/messages');
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /Grok is unavailable/);
});

test('the launcher registers one Grok worker whose default is the CLI default', () => {
  const other = { ...model, id: 'grok-4.5', model: 'multi/grok/grok-4.5', default: false };
  const agents = workerDefinitions(workerCatalog([other, model], [other, model]));
  assert.deepEqual(Object.keys(agents), ['multi-grok']);
  assert.equal(agents['multi-grok'].model, model.model);
  assert.match(agents['multi-grok'].description, /^Grok worker \(native Grok Build CLI\)/);
  assert.match(agents['multi-grok'].description, /omit it for grok-4\.6\.$/);
  assert.deepEqual(agents['multi-grok'].tools, [
    'Read',
    'Grep',
    'Glob',
    'Bash',
    'Edit',
    'Write',
    'mcp__multi-core',
  ]);
  // Rows the session does not show register no worker.
  assert.deepEqual(workerDefinitions(workerCatalog([], [model])), {});
});

test('the control plane treats every harness provider as one', () => {
  // A provider missing here records a Claude-loop snapshot instead of admitting a
  // settings policy, and its first prompt fails with an unadmitted-policy error.
  for (const model of ['multi/cursor/auto', 'multi/antigravity/gemini', 'multi/grok/grok-4.6']) {
    assert.equal(isHarnessModel(model), true, model);
  }
  for (const model of ['multi/openai/gpt-6-astra', 'multi/zen/glm-5.3', 'sonnet', undefined]) {
    assert.equal(isHarnessModel(model), false, String(model));
  }
});

test('a Grok worker is classified as harness execution, not a Claude loop', () => {
  const modes = new PermissionModes(async () => ({}));
  // A provider missing here would be admitted as a Claude-loop worker, skipping the
  // settings-policy translation its native tools depend on.
  for (const [parentModel, execution] of [
    ['multi/grok/grok-4.6', 'harness'],
    ['multi/antigravity/gemini', 'harness'],
    ['multi/openai/gpt-6-astra', 'claude'],
  ] as const) {
    assert.equal(
      modes.workerSelection({
        subagentType: 'custom',
        cwd: '/workspace',
        fork: true,
        parentModel,
      }).execution,
      execution,
      parentModel,
    );
  }
});

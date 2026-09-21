import assert from 'node:assert/strict';
import test from 'node:test';
import { AntigravityProviderError } from '../../plugins/multi-antigravity/src/harness.ts';
import { HarnessBusyError } from '../../plugins/multi-core/src/gateway/harness-session.ts';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';

const reply: MessagesResponse = {
  id: 'agy-test',
  type: 'message',
  role: 'assistant',
  model: 'multi/antigravity/gemini-test-low',
  content: [{ type: 'text', text: '[Antigravity] Native edit completed.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100 },
};

test('Antigravity routing resolves authenticated mode and never executes observed tools', async (t) => {
  const modes = new PermissionModes(async () => ({}));
  await modes.record({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'test-session',
    permission_mode: 'auto',
    prompt: 'edit the fixture',
  });
  let calls = 0;
  const server = createNativeGateway({
    token: 'test-token',
    authFile: '/unused',
    permissionModes: modes,
    antigravity: {
      validate: () => 10,
      handle: async (_body, scope, _signal, _emit, context) => {
        assert.equal(context?.permissionMode, 'auto');
        assert.match(scope, /test-session/);
        calls++;
        return reply;
      },
    },
    fetchImpl: async () => {
      throw new Error('Native Antigravity must not use a direct provider HTTP request');
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const request = (pathname: string) =>
    fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      method: 'POST',
      headers: {
        'x-multi-gateway-token': 'test-token',
        'x-claude-code-session-id': 'test-session',
      },
      body: JSON.stringify({
        model: reply.model,
        messages: [{ role: 'user', content: 'edit the fixture' }],
      }),
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

test('a busy Antigravity agent is answered 400, not a retryable 502', async (t) => {
  const modes = new PermissionModes(async () => ({}));
  await modes.record({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'busy-session',
    permission_mode: 'auto',
    prompt: 'edit the fixture',
  });
  const server = createNativeGateway({
    token: 'test-token',
    authFile: '/unused',
    permissionModes: modes,
    antigravity: {
      validate: () => 10,
      handle: async () => {
        throw new AntigravityProviderError(
          new HarnessBusyError('A different request is already running for this Antigravity agent'),
        );
      },
    },
    fetchImpl: async () => {
      throw new Error('Native Antigravity must not use a direct provider HTTP request');
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-multi-gateway-token': 'test-token',
      'x-claude-code-session-id': 'busy-session',
    },
    body: JSON.stringify({
      model: reply.model,
      messages: [{ role: 'user', content: 'typed while busy' }],
    }),
  });
  // A 502 is retryable, so Claude would re-send a prompt whose history stops at
  // the still-running turn and pay for that turn twice.
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /already running/);
});

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { GatewayFetch } from '../../plugins/multi-core/src/gateway/fetch.ts';
import type { GatewayOptions } from '../../plugins/multi-core/src/gateway/server.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';

const model = 'multi/zen/gpt-5.6-luna';
const request = {
  model,
  max_tokens: 1024,
  system: 'Stable instructions',
  messages: [{ role: 'user', content: 'Hello' }],
  metadata: { user_id: JSON.stringify({ session_id: 'session-one' }) },
};
const headers = {
  'content-type': 'application/json',
  'x-multi-gateway-token': 'local-fixture-token',
  authorization: 'Bearer claude-secret-fixture',
  'x-api-key': 'anthropic-secret-fixture',
};

test('disabled providers reject typed models and token counts without upstream requests', async (t) => {
  let requests = 0;
  const url = await gateway(
    t,
    async () => {
      requests++;
      return completion();
    },
    { enabledProviders: [] },
  );
  for (const provider of ['zen', 'openai', 'cursor', 'antigravity']) {
    for (const endpoint of ['/v1/messages', '/v1/messages/count_tokens']) {
      const response = await fetch(`${url}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request, model: `multi/${provider}/test` }),
      });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /not enabled/);
    }
  }
  assert.equal(requests, 0);
});

function completion(tool = false) {
  const output = tool
    ? [
        {
          type: 'function_call',
          name: 'Read',
          call_id: 'call_1',
          arguments: '{"file_path":"fixture"}',
        },
      ]
    : [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }];
  return new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'response_fixture',
        status: 'completed',
        output,
        usage: {
          input_tokens: 1000,
          output_tokens: 12,
          input_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
        },
      },
    })}\n\n`,
  );
}

async function gateway(
  t: TestContext,
  fetchImpl: GatewayFetch,
  extra: Partial<GatewayOptions> = {},
) {
  const server = createNativeGateway({
    token: 'local-fixture-token',
    authFile: '/nonexistent-codex-auth',
    zen: { apiKey: 'zen-secret-fixture' },
    blockAnthropic: true,
    fetchImpl,
    ...extra,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function post(base: string, body: unknown = request, extraHeaders = {}) {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

test('Zen isolates credentials, keeps cache affinity over restarts, and reports cache writes', async (t) => {
  const sent: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const upstream: GatewayFetch = async (url, init) => {
    assert.equal(url, 'https://opencode.ai/zen/v1/responses');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer zen-secret-fixture');
    assert.equal(init.headers['x-api-key'], undefined);
    assert.equal(init.headers['x-multi-gateway-token'], undefined);
    assert(!JSON.stringify(init.headers).includes('claude-secret-fixture'));
    sent.push({ headers: init.headers, body: JSON.parse(String(init.body)) });
    return completion();
  };
  const first = await gateway(t, upstream);
  const restarted = await gateway(t, upstream);
  const result = await (await post(first)).json();
  assert(result && typeof result === 'object' && 'model' in result && 'usage' in result);
  assert.equal(result.model, model);
  assert.deepEqual(result.usage, {
    input_tokens: 100,
    output_tokens: 12,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 100,
  });
  await (await post(restarted)).arrayBuffer();
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[0].body.prompt_cache_key, sent[0].headers['x-opencode-session']);
  assert.equal(sent[0].body.max_output_tokens, 1024);
  await (await post(restarted, request, { 'x-claude-code-agent-id': 'worker-one' })).arrayBuffer();
  await (await post(restarted, { ...request, model: 'multi/zen/gpt-5.6-sol' })).arrayBuffer();
  assert.notEqual(sent[0].body.prompt_cache_key, sent[2].body.prompt_cache_key);
  assert.notEqual(sent[0].body.prompt_cache_key, sent[3].body.prompt_cache_key);
});

test('Zen admission and counting never invoke inference; errors retain status without secrets or retries', async (t) => {
  let calls = 0;
  const base = await gateway(t, async () => {
    calls++;
    return new Response('SECRET_PROVIDER_ERROR', { status: 429, headers: { 'retry-after': '7' } });
  });
  const counted = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });
  assert.equal(counted.headers.get('x-multi-token-count'), 'estimate');
  const count = await counted.json();
  assert(count && typeof count === 'object' && 'input_tokens' in count);
  assert(typeof count.input_tokens === 'number' && count.input_tokens > 0);
  const bad = await post(base, { ...request, model: 'multi/zen/not-a-model' });
  assert.equal(bad.status, 400);
  const missing = await gateway(
    t,
    async () => {
      throw new Error('Must not call');
    },
    { zen: undefined },
  );
  assert.equal((await post(missing)).status, 400);
  assert.equal(calls, 0);
  const failure = await post(base);
  assert.equal(failure.status, 429);
  assert.equal(failure.headers.get('retry-after'), '7');
  assert.match(await failure.text(), /Zen returned HTTP 429/);
  assert.equal(calls, 1);
});

test('Zen native tools cannot acquire OpenAI review; explicit bypass stays explicit', async (t) => {
  let reviewed = 0;
  const base = await gateway(t, async () => completion(true), {
    guardAuto: true,
    approvalBridge: {
      respond: async () => {
        reviewed++;
        throw new Error('No cross-provider review');
      },
    },
  });
  const body = {
    ...request,
    tools: [
      {
        name: 'Read',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
    ],
  };
  for (const mode of ['auto', 'bypassPermissions', 'default', 'plan']) {
    const inference = await post(base, body);
    assert.equal(inference.status, 200);
    await inference.arrayBuffer();
    const hook = await fetch(`${base}/multi/permission`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        permission_mode: mode,
        session_id: 'session-one',
        tool_name: 'Read',
        tool_use_id: 'call_1',
      }),
    });
    const decision = await hook.json();
    if (mode !== 'auto') {
      assert.deepEqual(decision, {});
      continue;
    }
    assert.deepEqual(
      decision,
      {},
      'Zen keeps Claude native permission behavior when gateway attribution is unavailable',
    );
  }
  assert.equal(reviewed, 0);
});

test('Zen client disconnect aborts the upstream fetch without replay', async (t) => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  let calls = 0;
  const base = await gateway(t, async (_url, init) => {
    calls++;
    entered.resolve();
    return new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => {
          aborted.resolve();
          reject(init.signal.reason);
        },
        { once: true },
      );
    });
  });
  const controller = new AbortController();
  const result = fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...request, stream: true }),
    signal: controller.signal,
  }).catch(() => undefined);
  await entered.promise;
  controller.abort();
  await aborted.promise;
  await result;
  assert.equal(calls, 1);
});

test('Zen refuses invalid credential headers and missing terminal billing counts', async (t) => {
  assert.throws(
    () =>
      createNativeGateway({
        token: 'fixture',
        authFile: '/missing',
        zen: { apiKey: 'secret\nvalue' },
      }),
    (error: unknown) =>
      error instanceof Error && !error.message.includes('secret') && /API key/.test(error.message),
  );
  const base = await gateway(
    t,
    async () =>
      new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'missing_usage',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }],
          },
        })}\n\n`,
      ),
  );
  const response = await post(base);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /cost accounting is unavailable/);
});

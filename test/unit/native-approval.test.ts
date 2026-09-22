import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ApprovalContext,
  approvalCwdForComparison,
  NativeApprovalBridge,
  parseApprovalRequest,
} from '../../plugins/multi-core/src/gateway/approval.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import { removeTemporary } from '../temporary.ts';

const request = (stage = 1, session = 'session-one', command = 'node harmless-test.js') => ({
  model: 'claude-sonnet-5',
  metadata: { user_id: session },
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<transcript>\n' },
        { type: 'text', text: `${JSON.stringify({ user: 'Run the harmless test.' })}\n` },
        { type: 'text', text: `${JSON.stringify({ Bash: command })}\n` },
        { type: 'text', text: '</transcript>\n' },
        {
          type: 'text',
          text:
            (stage === 1
              ? 'Stage 1 does NOT apply user intent'
              : 'Review the classification process and follow it carefully.') +
            '\n<severity>N</severity>',
        },
      ],
    },
  ],
});

test('classifier policy is retained as admitted review evidence and cache identity', () => {
  const first = request() as ReturnType<typeof request> & { system: unknown };
  first.system = [{ type: 'text', text: 'Deny this exact command.' }];
  const parsed = parseApprovalRequest(first);
  assert.equal(parsed.policy, 'Deny this exact command.');
  const second = request() as ReturnType<typeof request> & { system: unknown };
  second.system = [{ type: 'text', text: 'Allow this exact command.' }];
  assert.notEqual(parsed.key, parseApprovalRequest(second).key);
  const malformed = request() as ReturnType<typeof request> & { system: unknown };
  malformed.system = [{ type: 'image', source: 'unexpected' }];
  assert.throws(() => parseApprovalRequest(malformed), /Malformed approval policy/);
});
const signal = () => new AbortController().signal;

test('permission hook keeps native admission when gateway attribution is unreachable', async () => {
  const hook = fileURLToPath(
    new URL('../../plugins/multi-core/src/gateway/permission-hook.ts', import.meta.url),
  );
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [hook], {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
        MULTI_GATEWAY_TOKEN: 'unavailable',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(`permission hook exited with ${code}`));
      }
    });
    child.stdin.end(JSON.stringify({ permission_mode: 'auto', tool_name: 'Read' }));
  });
  assert.deepEqual(JSON.parse(result), {});
});

test('native review preserves context, names actual provider, and never caches an allow', async () => {
  let calls = 0;
  const bridge = new NativeApprovalBridge(async (input) => {
    calls++;
    assert.deepEqual(input.action, { Bash: 'node harmless-test.js' });
    assert.deepEqual(input.transcript[0], { user: 'Run the harmless test.' });
    return { outcome: 'allow', model: 'codex-auto-review' };
  });
  const result = await bridge.respond(request(), signal());
  assert.equal(result.message.model, 'codex-auto-review');
  assert.equal(result.message.content[0].text, '<severity>0</severity>');
  await assert.rejects(bridge.respond(request(2), signal()), /no matching recent denial/);
  await bridge.respond(request(), signal());
  assert.equal(calls, 2);
});

test('second stage reuses only the same session and transcript denial, once', async () => {
  let calls = 0;
  const bridge = new NativeApprovalBridge(async () => {
    calls++;
    return { outcome: 'deny', model: 'codex-auto-review' };
  });
  await bridge.respond(request(), signal());
  await assert.rejects(bridge.respond(request(2, 'other-session'), signal()), /no matching/);
  await assert.rejects(
    bridge.respond(request(2, 'session-one', 'another-command'), signal()),
    /no matching/,
  );
  const changed = request(2);
  changed.messages[0].content[1].text = `${JSON.stringify({ user: 'New user instruction' })}\n`;
  await assert.rejects(bridge.respond(changed, signal()), /no matching/);
  const result = await bridge.respond(request(2), signal());
  assert.equal(result.cached, true);
  assert.equal(result.message.content[0].text, '<severity>100</severity>');
  assert.equal(calls, 1);
  await assert.rejects(bridge.respond(request(2), signal()), /no matching/);
});

test('ordinary inference and malformed classifier envelopes never reach reviewer', async () => {
  let calls = 0;
  const bridge = new NativeApprovalBridge(async () => {
    calls++;
    return { outcome: 'allow', model: 'codex-auto-review' };
  });
  const broken = request();
  broken.messages[0].content[2].text = 'not JSON';
  const future = request();
  const instruction = future.messages[0].content.at(-1);
  assert(instruction);
  instruction.text = 'Unknown protocol';
  for (const input of [
    { model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] },
    { ...request(), metadata: undefined },
    { ...request(), stream: true },
    { ...request(), tools: [{}] },
    broken,
    future,
  ]) {
    await assert.rejects(bridge.respond(input, signal()));
  }
  assert.equal(calls, 0);
});

test('denial cache evicts the oldest action without allowing a second-stage review', async () => {
  const bridge = new NativeApprovalBridge(async () => ({
    outcome: 'deny',
    model: 'codex-auto-review',
  }));
  for (let index = 0; index < 65; index++) {
    await bridge.respond(request(1, 'session', `command-${index}`), signal());
  }
  await assert.rejects(
    bridge.respond(request(2, 'session', 'command-0'), signal()),
    /no matching recent denial/,
  );
  const retained = await bridge.respond(request(2, 'session', 'command-1'), signal());
  assert.equal(retained.outcome, 'deny');
  assert.equal(retained.cached, true);
});

test('review errors, malformed verdicts, and cancellation cannot create approval state', async () => {
  for (const review of [
    async () => {
      throw new Error('Reviewer unavailable');
    },
    async () => ({ model: '', outcome: 'allow' as const }),
  ]) {
    const bridge = new NativeApprovalBridge(review);
    await assert.rejects(bridge.respond(request(), signal()));
    await assert.rejects(bridge.respond(request(2), signal()), /no matching/);
  }
  const abort = new AbortController();
  const bridge = new NativeApprovalBridge(async () => {
    abort.abort();
    return { outcome: 'deny', model: 'codex-auto-review' };
  });
  await assert.rejects(bridge.respond(request(), abort.signal));
  await assert.rejects(bridge.respond(request(2), signal()), /no matching/);
});

test('opt-in gateway review never forwards Anthropic traffic; authentication still applies', async (t) => {
  let fetches = 0;
  let reviews = 0;
  const routes: string[] = [];
  const server = createNativeGateway({
    token: 'test-token',
    authFile: '/unused',
    blockAnthropic: true,
    approvalBridge: new NativeApprovalBridge(async () => {
      reviews++;
      return { model: 'codex-auto-review', outcome: 'allow' };
    }),
    onEvent: (event) => routes.push(event.route),
    fetchImpl: async () => {
      fetches++;
      throw new Error('Unexpected upstream request');
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const send = (body: unknown, token = 'test-token') =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
      body: JSON.stringify(body),
    });
  assert.equal((await send(request(), 'wrong')).status, 403);
  const response = await send(request());
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { model: string }).model, 'codex-auto-review');
  // Claude retries a failed Sonnet classifier using the working model ID.
  assert.equal((await send({ ...request(), model: 'multi/openai/gpt-6-luna' })).status, 200);
  assert(
    (await send({ model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] })).status >= 400,
  );
  assert.deepEqual(routes, ['approval', 'approval']);
  assert.equal(reviews, 2);
  assert.equal(fetches, 0);
});

test('Claude-authenticated review cannot retry through ordinary external inference', async (t) => {
  const upstream: string[] = [];
  const server = createNativeGateway({
    token: 'test-token',
    authFile: '/unused',
    blockAnthropic: false,
    guardAuto: false,
    fetchImpl: async (url) => {
      upstream.push(url);
      return Response.json({ model: 'claude-sonnet-5' });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const send = (model: string) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-multi-gateway-token': 'test-token' },
      body: JSON.stringify({ ...request(), model }),
    });
  for (const model of ['multi/openai/gpt-6-luna', 'multi/cursor/composer-2.5']) {
    const response = await send(model);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /cannot use ordinary external inference/);
  }
  assert.deepEqual(upstream, []);
  assert.equal((await send('claude-sonnet-5')).status, 200);
  assert.deepEqual(upstream, ['https://api.anthropic.com/v1/messages']);
});

test('gateway isolates review context by worker and blocks classifier fallback from ordinary inference', async (t) => {
  const seen: string[] = [];
  let fetches = 0;
  const bridge = new NativeApprovalBridge(async (_input, _signal, context) => {
    if (!context) {
      throw new Error('Missing worker context');
    }
    seen.push(`${context.model}:${context.scope}`);
    return { model: 'codex-auto-review', outcome: 'allow' };
  });
  const server = createNativeGateway({
    token: 'token',
    authFile: '/missing',
    approvalBridge: bridge,
    fetchImpl: async () => {
      fetches++;
      throw new Error('No inference allowed in test');
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const send = (body: unknown, worker: string) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'x-multi-gateway-token': 'token', 'x-claude-code-agent-id': worker },
      body: JSON.stringify(body),
    });
  const inference = {
    model: 'multi/openai/gpt-6-luna',
    metadata: { user_id: 'session-one' },
    messages: [{ role: 'user', content: 'Work' }],
    tools: [{ name: 'Bash', input_schema: { type: 'object', properties: {} } }],
  };
  // Missing inference auth stops upstream access, while exercising independent request contexts.
  await send(inference, 'worker-a');
  assert.equal((await send(request(), 'worker-b')).status, 502);
  assert.equal((await send({ ...request(), model: inference.model }, 'worker-a')).status, 200);
  assert.equal(seen.length, 1);
  assert(seen[0].includes('worker-a'));
  await send({ ...inference, model: 'multi/cursor/auto' }, 'worker-b');
  assert.equal((await send(request(), 'worker-b')).status, 400);
  assert.equal(seen.length, 1, 'Cursor actions cannot borrow the OpenAI reviewer');
  assert.equal(fetches, 0);
});

test('classifier cwd comparison accepts Windows drive and UNC paths on Linux', () => {
  assert.equal(
    approvalCwdForComparison('C:\\Users\\runner\\repo', 'win32'),
    'C:/Users/runner/repo',
  );
  assert.equal(approvalCwdForComparison('\\\\server\\share\\repo', 'win32'), '//server/share/repo');
  assert.equal(approvalCwdForComparison('C:/Users/runner/repo', 'win32'), 'C:/Users/runner/repo');
  assert.equal(approvalCwdForComparison('C:/Users/runner/my repo', 'win32'), undefined);
});

test('headerless classifier uses pending worker context and rejects ambiguous actions', async (t) => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'approval-scope-'));
  t.after(() => removeTemporary(dir));
  await writeFile(
    `${dir}/auth.json`,
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake', account_id: 'fake' } }),
  );
  const contexts: ApprovalContext[] = [];
  const classifierCwd = process.platform === 'win32' ? 'C:\\Users\\runner\\workspace' : dir;
  let next = { id: 'tool-a', command: 'node a.js' };
  const server = createNativeGateway({
    token: 'token',
    authFile: `${dir}/auth.json`,
    guardAuto: true,
    approvalBridge: new NativeApprovalBridge(async (_input, _signal, context) => {
      assert(context);
      contexts.push(context);
      return { model: 'codex-auto-review', outcome: 'allow' };
    }),
    fetchImpl: async () => {
      const item = {
        type: 'function_call',
        call_id: next.id,
        name: 'Bash',
        arguments: JSON.stringify({ command: next.command }),
      };
      return new Response(
        [
          { type: 'response.created', response: { id: 'response' } },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: { id: 'response', usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      );
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const send = (body: unknown, endpoint = '/v1/messages', worker?: string) =>
    fetch(`http://127.0.0.1:${address.port}${endpoint}`, {
      method: 'POST',
      headers: {
        'x-multi-gateway-token': 'token',
        ...(worker ? { 'x-claude-code-agent-id': worker } : {}),
      },
      body: JSON.stringify(body),
    });
  const session = JSON.stringify({ session_id: 'session-one' });
  const prepare = async (
    worker: string,
    command: string,
    permissionMode = 'auto',
    pendingCommand = command,
    cwd = classifierCwd,
  ) => {
    next = { id: `tool-${worker}`, command: pendingCommand };
    const inference = await send(
      {
        model: 'multi/openai/gpt-6-luna',
        metadata: { user_id: session },
        messages: [{ role: 'user', content: worker }],
        tools: [
          {
            name: 'Bash',
            input_schema: { type: 'object', properties: { command: { type: 'string' } } },
          },
        ],
      },
      '/v1/messages',
      worker,
    );
    assert.equal(inference.status, 200);
    await inference.json();
    const guard = await send(
      {
        session_id: 'session-one',
        tool_use_id: `tool-${worker}`,
        tool_name: 'Bash',
        tool_input: { command: pendingCommand },
        cwd,
        permission_mode: permissionMode,
      },
      '/multi/permission',
    );
    assert.deepEqual(await guard.json(), {});
  };
  await prepare('worker-a', 'node a.js');
  await prepare('worker-b', 'node b.js', 'plan', `cd ${classifierCwd} && node b.js`);
  assert.equal(contexts.length, 0, 'Permission hooks must never invoke review');
  assert.equal((await send(request(1, session, 'node b.js'))).status, 200);
  assert(contexts[0].scope.includes('worker-b'));
  assert.equal(contexts[0].cwd, classifierCwd);
  assert.equal(contexts[0].request.messages?.[0].content, 'worker-b');
  await prepare('worker-b', 'node b.js', 'plan', 'cd /other-workspace && node b.js');
  assert.equal((await send(request(1, session, 'node b.js'))).status, 400);
  await prepare(
    'worker-b',
    'node b.js',
    'plan',
    `${process.execPath} -e ${JSON.stringify('process.stdout.write("unsafe")')}`,
    path.join(os.tmpdir(), 'unsafe').replaceAll('\\', '/'),
  );
  assert.equal((await send(request(1, session, 'node b.js'))).status, 400);
  await prepare('worker-b', 'node b.js', 'plan', `cd ${classifierCwd} && node b.js`);
  assert.equal((await send(request(1, session, 'node b.js'))).status, 200);
  await prepare('worker-a', 'node b.js');
  assert.equal((await send(request(1, session, 'node b.js'))).status, 400);
  assert.equal(contexts.length, 2);
});

const toolEvents = (id: string, command: string) => [
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id, name: 'Bash', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command }) },
  },
  { type: 'content_block_stop', index: 0 },
];

function providerToolResponse(url: string, id: string, command: string, stream: boolean) {
  if (url.includes('api.anthropic.com')) {
    if (!stream) {
      return Response.json({
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      });
    }
    const raw = `: keepalive\n\n${toolEvents(id, command)
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join('')}`;
    const bytes = new TextEncoder().encode(raw);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (let index = 0; index < bytes.length; index += 7) {
            controller.enqueue(bytes.slice(index, index + 7));
          }
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream', 'x-provider-test': 'preserved' } },
    );
  }
  const item = {
    type: 'function_call',
    call_id: id,
    name: 'Bash',
    arguments: JSON.stringify({ command }),
  };
  return new Response(
    [
      { type: 'response.created', response: { id: 'response' } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: { id: 'response', usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
  );
}

async function mixedReviewGateway(t: TestContext, reviewer = true, blockAnthropic = false) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mixed-review-'));
  t.after(() => removeTemporary(cwd));
  const authFile = path.join(cwd, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake', account_id: 'fake' } }),
  );
  const reviews: ApprovalContext[] = [];
  const nativeReviews: string[] = [];
  const nativeRequests: unknown[] = [];
  let outcome: 'allow' | 'deny' = 'allow';
  let next = { id: '', command: '', stream: false };
  const bridge = new NativeApprovalBridge(async (_input, _signal, context) => {
    assert(context);
    reviews.push(context);
    return { model: 'codex-auto-review', outcome };
  });
  const server = createNativeGateway({
    token: 'token',
    authFile,
    guardAuto: true,
    blockAnthropic,
    approvalBridge: reviewer ? bridge : undefined,
    zen: { apiKey: 'zen-fixture' },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.messages?.[0]?.content?.[0]?.text === '<transcript>\n') {
        assert(url.includes('api.anthropic.com'));
        nativeReviews.push(body.model);
        nativeRequests.push(body);
        return Response.json({
          model: body.model,
          content: [{ type: 'text', text: '<severity>0</severity>' }],
        });
      }
      return providerToolResponse(url, next.id, next.command, next.stream);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const send = (body: unknown, endpoint = '/v1/messages', worker?: string) =>
    fetch(`http://127.0.0.1:${address.port}${endpoint}`, {
      method: 'POST',
      headers: {
        'x-multi-gateway-token': 'token',
        ...(worker ? { 'x-claude-code-agent-id': worker } : {}),
      },
      body: JSON.stringify(body),
    });
  const prepare = async (model: string, command: string, worker?: string, stream = false) => {
    next = { id: `tool-${worker ?? 'main'}-${reviews.length}`, command, stream };
    const response = await send(
      {
        model,
        stream,
        metadata: { user_id: JSON.stringify({ session_id: 'mixed' }) },
        messages: [{ role: 'user', content: command }],
        tools: [
          {
            name: 'Bash',
            input_schema: { type: 'object', properties: { command: { type: 'string' } } },
          },
        ],
      },
      '/v1/messages',
      worker,
    );
    assert.equal(response.status, 200);
    const raw = await response.text();
    if (model.startsWith('claude') && stream) {
      assert.equal(response.headers.get('x-provider-test'), 'preserved');
      assert.equal(
        raw,
        `: keepalive\n\n${toolEvents(next.id, command)
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join('')}`,
      );
    }
    return send(
      {
        tool_use_id: next.id,
        session_id: 'mixed',
        tool_name: 'Bash',
        tool_input: { command },
        cwd,
        permission_mode: 'auto',
      },
      '/multi/permission',
    );
  };
  const infer = async (model: string, command: string, worker?: string) => {
    next = { id: `tool-${worker ?? 'main'}-${reviews.length}`, command, stream: false };
    const response = await send(
      {
        model,
        metadata: { user_id: JSON.stringify({ session_id: 'mixed' }) },
        messages: [{ role: 'user', content: command }],
        tools: [
          {
            name: 'Bash',
            input_schema: { type: 'object', properties: { command: { type: 'string' } } },
          },
        ],
      },
      '/v1/messages',
      worker,
    );
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  };
  const classify = (command: string, stage = 1, model = 'claude-sonnet-5', session = 'mixed') =>
    send({ ...request(stage, JSON.stringify({ session_id: session }), command), model });
  return {
    send,
    prepare,
    classify,
    reviews,
    nativeReviews,
    nativeRequests,
    infer,
    deny: () => {
      outcome = 'deny';
    },
  };
}

test('authenticated mixed-provider review follows main and headerless worker origins', async (t) => {
  const gateway = await mixedReviewGateway(t);
  const claude = 'claude-sonnet-5';
  const gpt = 'multi/openai/gpt-6-astra';
  const zen = 'multi/zen/gpt-6-luna';
  assert.deepEqual(
    await (await gateway.prepare(claude, 'node parent.js', undefined, true)).json(),
    {},
  );
  assert.deepEqual(
    await (await gateway.prepare(gpt, 'node worker.js', 'gpt-worker', true)).json(),
    {},
  );
  assert.equal((await gateway.classify('node worker.js')).status, 200);
  assert.equal(gateway.reviews[0].model, gpt);
  assert.equal(gateway.reviews[0].rootRequest?.messages?.[0].content, 'node parent.js');
  assert(gateway.reviews[0].scope.includes('gpt-worker'));
  assert.equal((await gateway.classify('node parent.js')).status, 200);
  assert.deepEqual(gateway.nativeReviews, [claude]);
  assert.deepEqual(await (await gateway.prepare(gpt, 'node main.js')).json(), {});
  assert.deepEqual(
    await (await gateway.prepare(claude, 'node claude-worker.js', 'claude-worker')).json(),
    {},
  );
  assert.equal((await gateway.classify('node claude-worker.js')).status, 200);
  assert.equal((await gateway.classify('node main.js', 1, gpt)).status, 200);
  assert.deepEqual(await (await gateway.prepare(zen, 'node zen.js')).json(), {});
  assert.equal((await gateway.classify('node zen.js')).status, 200);
  assert.equal(gateway.reviews.length, 2, 'Claude and Zen never borrow GPT review');
  assert.equal(gateway.nativeReviews.length, 3);
  assert.equal(
    (await gateway.classify('node main.js')).status,
    400,
    'A provider switch invalidates stale main actions',
  );
});

test('Claude-only Auto passes native classifier formats and fallback models through unchanged', async (t) => {
  const gateway = await mixedReviewGateway(t);
  await gateway.prepare('claude-fable-5-1', 'node original.js');
  const body = request(1, JSON.stringify({ session_id: 'mixed' }), 'native normalized command');
  body.model = 'claude-opus-5[1m]';
  body.messages[0].content.push({ type: 'text', text: 'A newer native classifier format.' });
  assert.equal((await gateway.send(body)).status, 200);
  assert.deepEqual(gateway.nativeReviews, ['claude-opus-5[1m]']);
  assert.deepEqual(gateway.nativeRequests, [body]);
  assert.deepEqual(gateway.reviews, []);
  assert.deepEqual(
    await (
      await gateway.send(
        { session_id: 'mixed', permission_mode: 'auto', tool_name: 'Bash' },
        '/multi/permission',
      )
    ).json(),
    {},
    'Native Auto does not depend on our pending-tool correlation',
  );
});

test('native Claude classifier retries survive an unrelated Zen context', async (t) => {
  const gateway = await mixedReviewGateway(t);
  await gateway.prepare('claude-sonnet-5', 'node claude-worker.js', 'claude-worker');
  await gateway.prepare('multi/zen/gpt-6-luna', 'node zen.js');
  const body = request(1, JSON.stringify({ session_id: 'mixed' }), 'node claude-worker.js');
  const instruction = body.messages[0].content.at(-1);
  assert(instruction);
  instruction.text = 'A native classifier format unknown to the gateway.';
  const response = await gateway.send(body);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.deepEqual(gateway.nativeReviews, ['claude-sonnet-5']);
  assert.deepEqual(gateway.reviews, []);
});

test('observed tools seed review without a permission roundtrip', async (t) => {
  const gateway = await mixedReviewGateway(t);
  await gateway.infer('multi/openai/gpt-6-astra', 'node gpt.js', 'gpt-worker');
  await gateway.infer('claude-sonnet-5', 'node claude.js', 'claude-worker');
  assert.equal((await gateway.classify('node claude.js')).status, 200);
  assert.deepEqual(gateway.nativeReviews, ['claude-sonnet-5']);
  assert.equal((await gateway.classify('node gpt.js')).status, 200);
  assert.equal(gateway.reviews.length, 1, 'OpenAI action keeps its originating reviewer');
});

test('mixed-provider review rejects missing, cross-session, ambiguous, and unavailable GPT origins', async (t) => {
  const gateway = await mixedReviewGateway(t, false);
  const gpt = 'multi/openai/gpt-6-astra';
  const guard = await gateway.prepare(gpt, 'node unavailable.js');
  assert.deepEqual(await guard.json(), {});
  assert.equal((await gateway.classify('node unavailable.js')).status, 400);
  assert.equal((await gateway.classify('node missing.js')).status, 400);
  assert.equal(
    (await gateway.classify('node unavailable.js', 1, 'claude-sonnet-5', 'other')).status,
    400,
  );
  await gateway.prepare('claude-sonnet-5', 'node unavailable.js', 'claude-worker');
  assert.equal((await gateway.classify('node unavailable.js')).status, 400);
  assert.deepEqual(
    gateway.nativeReviews,
    [],
    'Never fall back to Claude for an unavailable or ambiguous GPT reviewer',
  );
});

test('GPT second-stage denial remains provider-scoped with or without Claude credentials', async (t) => {
  for (const blockAnthropic of [false, true]) {
    const gateway = await mixedReviewGateway(t, true, blockAnthropic);
    gateway.deny();
    assert.deepEqual(
      await (await gateway.prepare('multi/openai/gpt-6-astra', 'node denied.js')).json(),
      {},
    );
    const first = await gateway.classify('node denied.js');
    assert.equal(first.status, 200);
    assert.partialDeepStrictEqual(await first.json(), {
      content: [{ text: '<severity>100</severity>' }],
    });
    assert.equal((await gateway.classify('node denied.js', 2)).status, 200);
    assert.equal(gateway.reviews.length, 1);
    assert.equal((await gateway.classify('node denied.js', 2)).status, 502);
    assert.deepEqual(gateway.nativeReviews, []);
  }
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import test from 'node:test';
import type { GatewayFetch } from '../../plugins/multi-core/src/gateway/fetch.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import {
  createOpenAIApproval,
  discoverOpenAIReviewer,
  inspectApprovalPath,
} from '../../plugins/multi-openai/src/approval.ts';
import { removeTemporary } from '../temporary.ts';

const request = (model = 'claude-sonnet-5') => ({
  model,
  metadata: { user_id: 'test-session' },
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<transcript>\n' },
        { type: 'text', text: `${JSON.stringify({ user: 'Run the workspace script.' })}\n` },
        { type: 'text', text: `${JSON.stringify({ Bash: 'node task.js' })}\n` },
        { type: 'text', text: '</transcript>\n' },
        { type: 'text', text: 'Stage 1 does NOT apply user intent <severity>N</severity>' },
      ],
    },
  ],
});
const context = {
  model: 'multi/openai/gpt-6-luna',
  scope: 'worker-one',
  request: { messages: [{ role: 'user', content: 'Run the workspace script.' }] },
};
const sse = (output: unknown[], status = 'completed') =>
  new Response(
    `data: ${JSON.stringify({ type: 'response.completed', response: { status, output } })}\n\n`,
  );
const verdict = (outcome = 'allow') => [
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ outcome }) }] },
];

test('reviewer promotes admitted hard blocks into mandatory instructions', async (t) => {
  const { cwd, authFile } = await fixture(t);
  const policy = '## HARD BLOCK\n- Deny CANARY unconditionally.\n\n## SOFT BLOCK\nSoft rules.';
  const bridge = await createOpenAIApproval(authFile, cwd, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    assert(body.instructions.includes('Deny CANARY unconditionally.'));
    assert(body.instructions.includes('Any matching hard block MUST return outcome deny'));
    assert(!body.instructions.includes('Soft rules.'));
    assert.equal(JSON.parse(body.input[0].content).admitted_classifier_policy, policy);
    return sse(verdict('deny'));
  });
  const result = await bridge.respond(
    { ...request(), system: [{ type: 'text', text: policy }] },
    new AbortController().signal,
    { ...context, cwd },
  );
  assert.equal(result.outcome, 'deny');
});

async function fixture(t: TestContext) {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'approval-unit-')));
  t.after(() => removeTemporary(cwd));
  const authFile = path.join(cwd, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'fake-openai', account_id: 'test-account' },
    }),
  );
  return { cwd, authFile };
}

test('runtime reviewer investigates with bounded read-only tools and uses provider auth/policy', async (t) => {
  const { cwd, authFile } = await fixture(t);
  await writeFile(path.join(cwd, 'task.js'), 'console.log("safe")');
  const requests: { input: Record<string, string>[] }[] = [];
  const bridge = await createOpenAIApproval(
    authFile,
    path.join(cwd, 'old-cwd'),
    async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(init.headers.authorization, 'Bearer fake-openai');
      const body = JSON.parse(String(init.body));
      requests.push(body);
      assert.equal(body.model, 'codex-auto-review');
      assert.deepEqual(
        body.tools.map((tool: { name: string }) => tool.name),
        ['inspect_path'],
      );
      assert(body.instructions.includes('Security Policy'));
      assert(!body.instructions.includes('MANUAL_ACCEPT'));
      if (requests.length === 1) {
        return sse([
          {
            type: 'function_call',
            name: 'inspect_path',
            call_id: 'inspect1',
            arguments: '{"path":"task.js"}',
          },
        ]);
      }
      assert.equal(JSON.parse(body.input.at(-1).output).content, 'console.log("safe")');
      return new Response(
        `data: ${JSON.stringify({ type: 'response.output_item.done', item: verdict()[0] })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`,
      );
    },
  );
  const result = await bridge.respond(request(), new AbortController().signal, { ...context, cwd });
  assert.equal(result.outcome, 'allow');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].input[0].role, 'user');
  assert.deepEqual(JSON.parse(requests[0].input[0].content).original_request, context.request);
});

test('reviewer errors, invalid output, foreign providers, and exhausted investigation cannot approve', async (t) => {
  const { cwd, authFile } = await fixture(t);
  for (const fetchImpl of [
    async () => new Response('unavailable', { status: 503 }),
    async () => sse(verdict('perhaps')),
    async () => sse([null]),
    async () => new Response('data: null\n\ndata: [DONE]\n\n'),
    async () => sse(verdict(), 'incomplete'),
    async () => sse([{ type: 'function_call', name: 'exec', call_id: 'bad', arguments: '{}' }]),
    async () =>
      sse([
        {
          type: 'function_call',
          name: 'inspect_path',
          call_id: 'read',
          arguments: '{"path":"missing"}',
        },
      ]),
  ] satisfies GatewayFetch[]) {
    const bridge = await createOpenAIApproval(authFile, cwd, fetchImpl);
    await assert.rejects(bridge.respond(request(), new AbortController().signal, context));
  }
  let calls = 0;
  const bridge = await createOpenAIApproval(authFile, cwd, async () => {
    calls++;
    return sse(verdict());
  });
  await assert.rejects(
    bridge.respond(request(), new AbortController().signal, {
      ...context,
      model: 'multi/cursor/auto',
    }),
  );
  await assert.rejects(bridge.respond(request(), new AbortController().signal));
  await assert.rejects(
    bridge.respond(request(), new AbortController().signal, { ...context, worker: true }),
  );
  await assert.rejects(
    bridge.respond(request(), new AbortController().signal, {
      ...context,
      request: { messages: [{ role: 'user', content: '界'.repeat(400000) }] },
    }),
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(bridge.respond(request(), abort.signal, context));
  assert.equal(calls, 0);
});

test('Windows inspection uses lstat protection before opening', async (t) => {
  const { cwd } = await fixture(t);
  await writeFile(path.join(cwd, 'safe.txt'), 'safe');
  const result = await inspectApprovalPath(cwd, { path: 'safe.txt' }, { platform: 'win32' });
  assert.deepEqual(result, {
    path: path.join(cwd, 'safe.txt'),
    bytes: 4,
    content: 'safe',
    truncated: false,
  });
  await symlink('safe.txt', path.join(cwd, 'link.txt'));
  await assert.rejects(
    inspectApprovalPath(cwd, { path: 'link.txt' }, { platform: 'win32' }),
    /symbolic links and reparse/,
  );
});

test('investigation enforces filesystem boundary and truncation; discovery never substitutes models', async (t) => {
  const { cwd, authFile } = await fixture(t);
  await mkdir(path.join(cwd, 'workspace'));
  await writeFile(path.join(cwd, 'outside'), 'private');
  await symlink(path.join(cwd, 'outside'), path.join(cwd, 'workspace', 'escape'));
  await assert.rejects(inspectApprovalPath(path.join(cwd, 'workspace'), { path: 'escape' }));
  await assert.rejects(inspectApprovalPath(path.join(cwd, 'workspace'), { path: '../outside' }));
  await writeFile(path.join(cwd, 'workspace', 'large'), 'x'.repeat(40000));
  const data = await inspectApprovalPath(path.join(cwd, 'workspace'), { path: 'large' });
  assert(data && typeof data === 'object');
  assert('content' in data && typeof data.content === 'string');
  assert('truncated' in data);
  assert.equal(data.content.length, 32768);
  assert.equal(data.truncated, true);
  for (const [slug, expected] of [
    ['gpt-6-luna', false],
    ['codex-auto-review', true],
  ] as const) {
    assert.equal(
      await discoverOpenAIReviewer(authFile, async () => Response.json({ models: [{ slug }] })),
      expected,
    );
  }
  assert.equal(
    await discoverOpenAIReviewer(authFile, async () => new Response('', { status: 401 })),
    false,
  );
});

test('OpenAI reviewer refuses a review context owned by another provider', async (t) => {
  const { cwd, authFile } = await fixture(t);
  let calls = 0;
  const bridge = await createOpenAIApproval(authFile, cwd, async () => {
    calls++;
    return sse(verdict());
  });
  await assert.rejects(
    bridge.respond(request(), new AbortController().signal, {
      ...context,
      model: 'multi/cursor/auto',
    }),
    { message: 'Automatic approval is unavailable for this provider' },
  );
  assert.equal(calls, 0);
});

test('required review without an eligible reviewer fails instead of forwarding as approval', async (t) => {
  const { authFile } = await fixture(t);
  const eligible = await discoverOpenAIReviewer(authFile, async () =>
    Response.json({ models: [{ slug: 'gpt-6-luna' }] }),
  );
  assert.equal(eligible, false);
  const server = createNativeGateway({
    token: 'approval-token',
    authFile,
    blockAnthropic: true,
    fetchImpl: async () => {
      throw new Error('request must not fall back to a provider without a reviewer');
    },
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-multi-gateway-token': 'approval-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'test' }],
    }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { message: string } };
  assert.equal(
    body.error.message,
    'Native gateway: Anthropic is not signed in. Select an external model.',
  );
});

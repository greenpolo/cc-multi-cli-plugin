import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { GatewayFetch } from '../../plugins/multi-core/src/gateway/fetch.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import {
  createOpenAIReviewer,
  discoverOpenAIReviewer,
  inspectApprovalPath,
} from '../../plugins/multi-openai/src/approval.ts';
import { removeTemporary } from '../temporary.ts';

const context = {
  tool: {
    type: 'tool_use' as const,
    id: 'call_1',
    name: 'Bash',
    input: { command: 'node task.js' },
  },
  planMode: false,
  request: { messages: [{ role: 'user', content: 'Run the workspace script.' }] },
};
const sse = (output: unknown[], status = 'completed') =>
  new Response(
    `data: ${JSON.stringify({ type: 'response.completed', response: { status, output } })}\n\n`,
  );
const verdict = (outcome = 'allow') => [
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ outcome }) }] },
];

test('reviewer receives the admitted plan-mode restriction only in plan mode', async (t) => {
  const { cwd, authFile } = await fixture(t);
  const instructions: string[] = [];
  const bridge = await createOpenAIReviewer(authFile, cwd, async (_url, init) => {
    instructions.push(JSON.parse(String(init.body)).instructions);
    return sse(verdict('deny'));
  });
  for (const planMode of [true, false]) {
    await bridge({ ...context, cwd, planMode }, new AbortController().signal);
  }
  assert.match(instructions[0] ?? '', /plan mode is active[\s\S]*Allow only read-only actions/);
  assert.doesNotMatch(instructions[1] ?? '', /plan mode is active/);
});

test('reviewer evidence carries the user auto-mode and permission rules, not the rest of the classifier context', async (t) => {
  const { cwd, authFile } = await fixture(t);
  const bodies: Array<{ instructions: string; input: Array<{ content: string }> }> = [];
  const bridge = await createOpenAIReviewer(authFile, cwd, async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    return sse(verdict('deny'));
  });
  const auto_mode = { allow: [], soft_deny: [], hard_deny: ['Never run DENY_CANARY'] };
  const rules = { allow: [], deny: ['Bash(rm:*)'], ask: [] };
  const request = {
    ...context.request,
    safeguards: [
      {
        type: 'dangerous_tool_use',
        classifier_context: {
          permission_mode: 'auto',
          home_dir: '/home/private',
          auto_mode,
          rules,
        },
      },
    ],
  };
  await bridge({ ...context, cwd, request }, new AbortController().signal);
  const evidence = JSON.parse(bodies[0]?.input[0]?.content ?? '{}');
  assert.deepEqual(evidence.user_policy, { auto_mode, rules });
  assert.doesNotMatch(JSON.stringify(evidence.user_policy), /home_dir/);
  assert.match(bodies[0]?.instructions ?? '', /user_policy[\s\S]*hard_deny/);
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
  const bridge = await createOpenAIReviewer(
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
  const result = await bridge({ ...context, cwd }, new AbortController().signal);
  assert.equal(result.outcome, 'allow');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].input[0].role, 'user');
  assert.deepEqual(JSON.parse(requests[0].input[0].content).original_request, context.request);
});

test('reviewer errors, invalid output, and exhausted investigation cannot approve', async (t) => {
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
    const bridge = await createOpenAIReviewer(authFile, cwd, fetchImpl);
    await assert.rejects(bridge(context, new AbortController().signal));
  }
  let calls = 0;
  const bridge = await createOpenAIReviewer(authFile, cwd, async () => {
    calls++;
    return sse(verdict());
  });
  await assert.rejects(bridge({ ...context, worker: true }, new AbortController().signal));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(bridge(context, abort.signal));
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

test('long main and worker evidence drops schemas and keeps system heads and recent messages within budget', async (t) => {
  const { cwd, authFile } = await fixture(t);
  const evidence: Array<Record<string, unknown>> = [];
  const bridge = await createOpenAIReviewer(authFile, cwd, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const text = body.input[0].content;
    assert(Buffer.byteLength(text) <= 1048576);
    assert.doesNotMatch(body.instructions, /supplied transcript|worker transcript/);
    evidence.push(JSON.parse(text));
    return sse(verdict());
  });
  const messages = Array.from({ length: 80 }, (_, index) => ({
    role: 'user',
    content: `${'\u0000"\\界'.repeat(5000)}RECENT_${index}`,
  }));
  const request = {
    system: `SYSTEM_HEAD${'界'.repeat(500000)}`,
    messages,
    tools: [{ name: 'Bash', description: 'SCHEMA_ONLY'.repeat(200000), input_schema: {} }],
  };
  for (const worker of [false, true]) {
    const result = await bridge(
      { ...context, worker, request, rootRequest: request },
      new AbortController().signal,
    );
    assert.equal(result.outcome, 'allow');
  }
  assert.equal(
    Object.hasOwn(evidence[0], 'root_request'),
    false,
    'main-loop evidence appears only once',
  );
  for (const entry of evidence) {
    const original = entry.original_request as {
      system: { json_head: string };
      messages: unknown[];
      omitted_messages: number;
      tools?: unknown;
    };
    assert.equal(original.tools, undefined);
    assert.match(original.system.json_head, /SYSTEM_HEAD/);
    assert.match(JSON.stringify(original.messages.at(-1)), /RECENT_79/);
    assert(original.omitted_messages > 0);
    assert.deepEqual(entry.planned_action, { Bash: { command: 'node task.js' } });
  }
  assert(Object.hasOwn(evidence[1], 'root_request'));
});

test('all reviewer instances share four slots, cancel queued calls and release slots on failure or abort', async (t) => {
  const { cwd, authFile } = await fixture(t);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let active = 0;
  let peak = 0;
  let calls = 0;
  const fetchImpl: GatewayFetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init.body));
    const fail = JSON.parse(body.input[0].content).planned_action.Bash.command === 'FAIL';
    active++;
    peak = Math.max(peak, active);
    if (calls === 4) {
      entered.resolve();
    }
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(init.signal.reason);
    init.signal.addEventListener('abort', abort, { once: true });
    try {
      await Promise.race([gate.promise, aborted.promise]);
      return fail ? new Response('', { status: 503 }) : sse(verdict());
    } finally {
      active--;
      init.signal.removeEventListener('abort', abort);
    }
  };
  const reviewers = await Promise.all([
    createOpenAIReviewer(authFile, cwd, fetchImpl),
    createOpenAIReviewer(authFile, cwd, fetchImpl),
  ]);
  const aborts = Array.from({ length: 10 }, () => new AbortController());
  const settled = Promise.allSettled(
    aborts.map((abort, index) =>
      reviewers[index % 2](
        {
          ...context,
          tool: { ...context.tool, input: { command: index === 0 ? 'FAIL' : 'allow' } },
        },
        abort.signal,
      ),
    ),
  );
  await entered.promise;
  assert.equal(calls, 4);
  aborts[6].abort(new Error('cancelled while queued'));
  aborts[1].abort(new Error('cancelled while active'));
  await setImmediate();
  gate.resolve();
  const results = await settled;
  assert.equal(peak, 4);
  assert.equal(calls, 9, 'the cancelled queued call never reached Codex');
  assert.equal(active, 0);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 3);
  assert.equal((await reviewers[0](context, new AbortController().signal)).outcome, 'allow');
});

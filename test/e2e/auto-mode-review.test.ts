import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { HarnessResponse } from '../../plugins/multi-core/src/gateway/harness-response.ts';
import type {
  ContentEventBody,
  ContentEventName,
  MessagesRequest,
  MessagesResponse,
  ServedReply,
} from '../../plugins/multi-core/src/gateway/messages.ts';
import type { NativeHarness } from '../../plugins/multi-core/src/gateway/native-harness.ts';
import {
  createNativeGateway,
  type GatewayEvent,
  type GatewayOptions,
} from '../../plugins/multi-core/src/gateway/server.ts';
import { createOpenAIReviewer } from '../../plugins/multi-openai/src/approval.ts';

const model = 'multi/openai/gpt-6-luna';
const safeguards = [
  { type: 'dangerous_tool_use', classifier_context: { permission_mode: 'auto' } },
];
const events = (output: unknown[]) =>
  new Response(
    [
      { type: 'response.created', response: { id: 'resp_stub', usage: null } },
      {
        type: 'response.completed',
        response: {
          id: 'resp_stub',
          status: 'completed',
          output,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
  );
const tool = (id: string) => ({
  type: 'function_call',
  call_id: id,
  name: 'Bash',
  arguments: JSON.stringify({ command: id }),
});
const request: MessagesRequest = {
  model,
  safeguards,
  messages: [{ role: 'user', content: 'Allow approved; refuse denied.' }],
  tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
};

async function gateway(t: test.TestContext, options: Partial<GatewayOptions> = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'arbiter-e2e-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const authFile = path.join(cwd, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'stub', account_id: 'stub' } }),
  );
  const traces: GatewayEvent[] = [];
  const reviews: Record<string, unknown>[] = [];
  const reviewer = await createOpenAIReviewer(authFile, cwd, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    reviews.push(body);
    const evidence = JSON.parse(body.input[0].content);
    const action = evidence.planned_action.Bash.command;
    if (action === 'failed') {
      return new Response('', { status: 503 });
    }
    return events([
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              outcome: action === 'denied' ? 'deny' : 'allow',
              rationale: 'Scripted review decision.',
            }),
          },
        ],
      },
    ]);
  });
  const server = createNativeGateway({
    token: 'test',
    authFile,
    reviewers: { openai: reviewer },
    onEvent: (event) => traces.push(event),
    fetchImpl: async () => events([tool('approved'), tool('denied'), tool('failed')]),
    ...options,
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: MessagesRequest, headers: Record<string, string> = {}) =>
    fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'x-multi-gateway-token': 'test', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  return { post, reviews, traces, base, server };
}

function postcondition(reply: ServedReply) {
  const verdicts = reply.safeguard_results?.[0].status.tool_uses;
  assert(verdicts, 'a completed reply carries results even without tools');
  for (const block of reply.content) {
    if (block.type === 'tool_use') {
      assert(Object.hasOwn(verdicts, block.id), block.id);
      assert.equal(verdicts[block.id].type, 'evaluated');
    }
  }
  return verdicts;
}
function streamed(raw: string): ServedReply {
  const parsed = raw
    .split('\n\n')
    .filter((part) => part.startsWith('event: '))
    .map((part) => JSON.parse(part.slice(part.indexOf('data: ') + 6)));
  assert.equal(parsed.filter((event) => event.type === 'message_delta').length, 1);
  assert.equal(parsed.filter((event) => event.type === 'message_stop').length, 1);
  const start = parsed.find((event) => event.type === 'message_start').message;
  const content = parsed
    .filter((event) => event.type === 'content_block_start')
    .map((event) => event.content_block);
  const terminal = parsed.find((event) => event.type === 'message_delta');
  return { ...start, content, ...terminal.delta };
}

test('offline arbiter: stub Codex allows, denies and fails inline in JSON and SSE without local classification', async (t) => {
  const f = await gateway(t);
  for (const stream of [false, true]) {
    const response = await f.post({ ...request, stream });
    assert.equal(response.status, 200);
    const reply = stream
      ? streamed(await response.text())
      : ((await response.json()) as ServedReply);
    const verdicts = postcondition(reply);
    assert.equal(verdicts.approved.outcome, 'not_flagged');
    assert.equal(verdicts.denied.outcome, 'flagged');
    assert.equal(verdicts.failed.outcome, 'flagged');
  }
  assert.equal(f.reviews.length, 6);
  assert.equal(f.traces.filter((event) => event.route === 'review').length, 6);
  assert.equal(f.traces.filter((event) => event.route === 'anthropic').length, 0);
});

test('every served failure and text-only path carries empty results, including JSON keepalive failure', async (t) => {
  const f = await gateway(t, {
    jsonKeepAliveMs: 1,
    fetchImpl: async () => {
      await setTimeout(30);
      throw new Error('invalid safeguards dangerous-tool-use beta');
    },
  });
  const response = await f.post(request);
  assert.equal(response.status, 200);
  const reply = (await response.json()) as ServedReply;
  assert.deepEqual(postcondition(reply), {});
  assert.doesNotMatch(JSON.stringify(reply.content), /safeguards|dangerous-tool-use|beta/i);
  const text = await gateway(t, {
    fetchImpl: async () =>
      events([{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }]),
  });
  for (const stream of [false, true]) {
    const result = await text.post({ ...request, stream });
    const reply = stream ? streamed(await result.text()) : ((await result.json()) as ServedReply);
    assert.deepEqual(postcondition(reply), {});
  }
});

test('main-loop HTTP errors are latch-safe and the retired permission route is absent', async (t) => {
  const f = await gateway(t, {
    fetchImpl: async () => {
      throw new Error('invalid SAFEGUARDS dangerous-tool-use BETA');
    },
  });
  const result = await f.post(request);
  assert.equal(result.status, 502);
  assert.doesNotMatch(await result.text(), /safeguards|dangerous-tool-use|beta/i);
  const invalid = await f.post({
    ...request,
    model: 'multi/openai/safeguards-beta-dangerous-tool-use',
  });
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(await invalid.text(), /safeguards|dangerous-tool-use|beta/i);
  const retired = await fetch(`${f.base}/multi/permission`, {
    method: 'POST',
    headers: { 'x-multi-gateway-token': 'test' },
    body: '{}',
  });
  assert.equal(retired.status, 404);
});

test('all harness delivery and replay paths finalise current-request verdicts without terminal replay', async (t) => {
  for (const provider of ['cursor', 'antigravity', 'grok'] as const) {
    let runs = 0;
    const cached = new Map<
      string,
      { reply: MessagesResponse; events: Array<[ContentEventName, ContentEventBody]> }
    >();
    let recorded: MessagesResponse | undefined;
    const harness: NativeHarness = {
      validate: () => 1,
      async handle(body, _scope, _signal, emit) {
        const key = JSON.stringify(body.messages);
        const held = cached.get(key);
        if (held) {
          for (const event of held.events) {
            emit?.(...event);
          }
          return held.reply;
        }
        runs++;
        const contentEvents: Array<[ContentEventName, ContentEventBody]> = [];
        const response = new HarnessResponse(body.model ?? '', 1, (type, value) => {
          contentEvents.push([type, structuredClone(value)]);
          emit?.(type, value);
        });
        response.text('Report.');
        response.displayRow({
          type: 'tool_use',
          id: `toolu_multi_${'a'.repeat(32)}`,
          name: 'mcp__multi-core__read',
          input: {},
        });
        response.text('Final report.');
        recorded = response.finish(undefined);
        cached.set(key, { reply: recorded, events: contentEvents });
        return recorded;
      },
      recordedResponse: async () => recorded,
    };
    const f = await gateway(t, { [provider]: harness });
    const body: MessagesRequest = {
      ...request,
      model: `multi/${provider}/test`,
      tools: [{ name: 'SubagentHandback', input_schema: { type: 'object' } }],
    };
    // The original native run asked for no verdicts. Replay must use the new request.
    await (await f.post({ ...body, safeguards: undefined })).text();
    const replay = await f.post({ ...body, stream: true });
    const first = streamed(await replay.text());
    postcondition(first);
    assert.equal(runs, 1);
    const row = first.content.find((block) => block.type === 'tool_use');
    assert(row?.type === 'tool_use');
    const continuation: MessagesRequest = {
      ...body,
      messages: [
        ...(body.messages ?? []),
        { role: 'assistant', content: first.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: row.id, content: 'shown' }] },
      ],
    };
    for (const stream of [false, true]) {
      const result = await f.post({ ...continuation, stream });
      const reply = stream ? streamed(await result.text()) : ((await result.json()) as ServedReply);
      const map = postcondition(reply);
      const handback = reply.content.find(
        (block) => block.type === 'tool_use' && block.name === 'SubagentHandback',
      );
      assert(handback?.type === 'tool_use');
      assert.equal(map[handback.id].outcome, 'not_flagged');
    }
    const bounce = await f.post({
      ...body,
      stream: true,
      messages: [{ role: 'user', content: '[handback-send-enforce] Deliver the report.' }],
    });
    postcondition(streamed(await bounce.text()));
    assert.equal(runs, 1);
  }
});

test('OpenAI worker reviews receive the main request; later private classifier traffic passes through untouched', async (t) => {
  const upstreamBodies: string[] = [];
  const f = await gateway(t, {
    fetchImpl: async (url, init) => {
      if (new URL(url).hostname === 'chatgpt.com') {
        return events([tool('approved')]);
      }
      upstreamBodies.push(String(init.body));
      return new Response('unchanged-classifier-response');
    },
  });
  const headers = { 'x-claude-code-session-id': 'review-session' };
  await (await f.post(request, headers)).text();
  const workerRequest = { ...request, messages: [{ role: 'user', content: 'Delegated task.' }] };
  const worker = await f.post(workerRequest, {
    ...headers,
    'x-claude-code-agent-id': 'worker-one',
  });
  const verdict = postcondition((await worker.json()) as ServedReply);
  assert.equal(verdict.approved.outcome, 'not_flagged');
  const evidence = JSON.parse(
    String((f.reviews[1].input as Array<{ content: string }>)[0].content),
  );
  assert.deepEqual(evidence.root_request.messages, request.messages);
  assert.deepEqual(evidence.original_request.messages, workerRequest.messages);
  const classifier = {
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: 'A future private classifier format with no parseable action.' },
    ],
  };
  const passthrough = await f.post(classifier, headers);
  assert.equal(passthrough.status, 200);
  assert.equal(await passthrough.text(), 'unchanged-classifier-response');
  assert.deepEqual(upstreamBodies, [JSON.stringify(classifier)]);
  assert.equal(f.reviews.length, 2);
  const mainEvidence = JSON.parse(
    String((f.reviews[0].input as Array<{ content: string }>)[0].content),
  );
  assert.equal(mainEvidence.root_request, undefined);
});

test('Zen Chat and Responses finalise per-mode verdicts without borrowing the OpenAI reviewer', async (t) => {
  for (const nativeModel of ['gpt-5.6-luna', 'deepseek-v4.1-flash']) {
    const chat = nativeModel.startsWith('deepseek');
    const f = await gateway(t, {
      zen: { apiKey: 'stub-key' },
      fetchImpl: async () => {
        if (!chat) {
          return events([tool('zen-call')]);
        }
        const chunk = {
          id: 'chat-stub',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'zen-call',
                    type: 'function',
                    function: { name: 'Bash', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      },
    });
    for (const mode of ['auto', 'plan']) {
      for (const stream of [false, true]) {
        const response = await f.post({
          ...request,
          model: `multi/zen/${nativeModel}`,
          stream,
          safeguards: [
            { type: 'dangerous_tool_use', classifier_context: { permission_mode: mode } },
          ],
        });
        assert.equal(response.status, 200);
        const reply = stream
          ? streamed(await response.text())
          : ((await response.json()) as ServedReply);
        assert.equal(
          postcondition(reply)['zen-call'].outcome,
          mode === 'plan' ? 'flagged' : 'not_flagged',
        );
      }
    }
    assert.equal(f.reviews.length, 0);
  }
});

test('missing OpenAI reviewer remains autonomous in Auto, refuses Plan and states its policy', async (t) => {
  const f = await gateway(t, { reviewers: {} });
  for (const mode of ['auto', 'plan']) {
    const response = await f.post({
      ...request,
      safeguards: [{ type: 'dangerous_tool_use', classifier_context: { permission_mode: mode } }],
    });
    assert.equal(response.status, 200);
    const verdicts = postcondition((await response.json()) as ServedReply);
    assert.equal(verdicts.approved.outcome, mode === 'plan' ? 'flagged' : 'not_flagged');
  }
  const telemetry = await fetch(`${f.base}/multi/mod/telemetry`, {
    method: 'POST',
    headers: { 'x-multi-gateway-token': 'test' },
    body: JSON.stringify({ sessionId: 'policy-session', model }),
  });
  const state = (await telemetry.json()) as { reviewStatement: string };
  assert.match(state.reviewStatement, /OpenAI reviewer unavailable.*actions run unreviewed/);
  assert.equal(f.reviews.length, 0);
});

test('stop sequences cancel upstream generation before review without cancelling the reviewer', async (t) => {
  let upstreamSignal: AbortSignal | undefined;
  let reviewed = false;
  const f = await gateway(t, {
    fetchImpl: async (_url, init) => {
      upstreamSignal = init.signal;
      const output = [
        { type: 'response.created', response: { id: 'stop-test', usage: null } },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...tool('approved'), arguments: '' },
        },
        { type: 'response.output_item.done', output_index: 0, item: tool('approved') },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'message', id: 'text-stop', content: [] },
        },
        { type: 'response.output_text.delta', output_index: 1, delta: 'Done STOP excess' },
        {
          type: 'response.completed',
          response: {
            id: 'stop-test',
            status: 'completed',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      ];
      return new Response(output.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    },
    reviewers: {
      openai: async (_input, signal) => {
        reviewed = true;
        assert.equal(upstreamSignal?.aborted, true);
        assert.equal(signal.aborted, false);
        return { model: 'stub-reviewer', outcome: 'allow' };
      },
    },
  });
  const response = await f.post({ ...request, stop_sequences: ['STOP'] });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const reply = JSON.parse(raw) as ServedReply;
  assert.equal(reply.stop_reason, 'stop_sequence');
  assert.equal(postcondition(reply).approved.outcome, 'not_flagged');
  assert.equal(reviewed, true);
});

test('a failure while delivering a keepalive failure drops the transport without an unhandled rejection', async (t) => {
  const f = await gateway(t, {
    jsonKeepAliveMs: 1,
    fetchImpl: async () => {
      await setTimeout(20);
      throw new Error('upstream failed');
    },
  });
  let breakDelivery = true;
  f.server.on('request', (_req, res) => {
    if (breakDelivery) {
      breakDelivery = false;
      Object.defineProperty(res, 'end', {
        value: () => {
          throw new Error('failure delivery broke');
        },
      });
    }
  });
  await assert.rejects(async () => {
    await (await f.post(request)).text();
  }, /terminated|closed|fetch failed/);
  const second = await f.post(request);
  assert.equal(second.status, 200);
  assert.deepEqual(postcondition((await second.json()) as ServedReply), {});
});

test('signed-out Claude leaves external Auto available and refuses every Anthropic-only request locally', async (t) => {
  const f = await gateway(t, { blockAnthropic: true });
  const external = await f.post(request);
  assert.equal(external.status, 200);
  assert.equal(
    postcondition((await external.json()) as ServedReply).approved.outcome,
    'not_flagged',
  );
  for (const content of [
    'native Claude inference',
    'always-local handback review',
    'workflow gate review',
    'sandbox network review',
  ]) {
    const local = await f.post({ model: 'claude-sonnet-5', messages: [{ role: 'user', content }] });
    assert.equal(local.status, 400);
    assert.match(await local.text(), /Anthropic is not signed in/);
  }
  assert.equal(
    f.traces.some((event) => event.route === 'anthropic'),
    false,
  );
});

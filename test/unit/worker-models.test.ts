import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { fromResponses } from '../../plugins/multi-core/src/gateway/responses.ts';
import {
  createNativeGateway,
  type GatewayOptions,
} from '../../plugins/multi-core/src/gateway/server.ts';
import {
  stripWorkerJson,
  stripWorkerModel,
  stripWorkerSse,
  WorkerModels,
} from '../../plugins/multi-core/src/gateway/worker-models.ts';
import { workerCatalog } from '../../plugins/multi-core/src/launcher.ts';
import { fromChat } from '../../plugins/multi-zen/src/chat.ts';

const frame = (type: string, value: object, eol = '\n') =>
  `event: ${type}${eol}data: ${JSON.stringify({ type, ...value })}${eol}${eol}`;
const input = { subagent_type: 'multi-openai', model: 'gpt-6-luna', prompt: 'Inspect café 🐈' };
const tool = (name = 'Agent', value: unknown = input, id = 'toolu_named') => ({
  type: 'tool_use',
  id,
  name,
  input: value,
});
function callFrames(
  value: unknown = input,
  name = 'Agent',
  index = 0,
  id = 'toolu_named',
  eol = '\n',
) {
  const json = JSON.stringify(value);
  return (
    frame('content_block_start', { index, content_block: tool(name, {}, id) }, eol) +
    frame(
      'content_block_delta',
      { index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 25) } },
      eol,
    ) +
    frame(
      'content_block_delta',
      { index, delta: { type: 'input_json_delta', partial_json: json.slice(25) } },
      eol,
    ) +
    frame('content_block_stop', { index }, eol)
  );
}
async function transform(raw: Buffer, chunks: number[], remember = () => {}) {
  async function* source() {
    let offset = 0;
    for (const length of chunks) {
      yield raw.subarray(offset, offset + length);
      offset += length;
    }
    yield raw.subarray(offset);
  }
  const output: Buffer[] = [];
  for await (const chunk of stripWorkerSse(source(), remember)) {
    output.push(chunk);
  }
  return Buffer.concat(output);
}
function data(raw: Buffer) {
  return raw
    .toString()
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((part) => JSON.parse(part.slice(part.indexOf('data: ') + 6)));
}

test('SSE strips one Agent delta across every byte boundary, including UTF-8 and CRLF', async () => {
  for (const eol of ['\n', '\r\n']) {
    const raw = Buffer.from(callFrames(input, 'Agent', 0, 'toolu_named', eol));
    for (let boundary = 1; boundary < raw.length; boundary++) {
      const remembered: unknown[] = [];
      const result = await transform(raw, [boundary], (...args: unknown[]) => {
        remembered.push(args);
      });
      const deltas = data(result).filter((event) => event.type === 'content_block_delta');
      assert.equal(deltas.length, 1);
      assert.deepEqual(JSON.parse(deltas[0].delta.partial_json), {
        subagent_type: input.subagent_type,
        prompt: input.prompt,
      });
      assert.deepEqual(remembered, [['toolu_named', 'multi-openai', 'gpt-6-luna']]);
    }
    assert.deepEqual(await transform(raw, Array(raw.length).fill(1)), await transform(raw, []));
  }
});

test('SSE preserves non-provider Agents, other tools, text, thinking and malformed input verbatim', async () => {
  const malformed =
    frame('content_block_start', { index: 5, content_block: tool('Agent', {}, 'bad') }) +
    frame('content_block_delta', {
      index: 5,
      delta: { type: 'input_json_delta', partial_json: '{bad' },
    }) +
    frame('content_block_stop', { index: 5 });
  const raw = Buffer.from(
    callFrames({ ...input, subagent_type: 'Explore' }) +
      callFrames(input, 'Bash', 1) +
      callFrames({ ...input, model: 4 }, 'Agent', 2) +
      frame('content_block_start', {
        index: 3,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }) +
      frame('content_block_delta', {
        index: 3,
        delta: { type: 'thinking_delta', thinking: 'ponder' },
      }) +
      frame('content_block_stop', { index: 3 }) +
      frame('content_block_start', {
        index: 4,
        content_block: { type: 'text', text: 'untouched' },
      }) +
      malformed +
      'data: invalid\r\n\r\n',
  );
  assert.deepEqual(await transform(raw, Array(raw.length).fill(1)), raw);
});

test('SSE keeps two tool ids, verdict bytes, stop frames and immediate pings', async () => {
  const first = callFrames();
  const ping = frame('ping', {});
  const verdict = frame(
    'message_delta',
    {
      delta: {
        safeguard_results: [
          { status: { tool_uses: { toolu_named: 'not_flagged', second: 'not_flagged' } } },
        ],
      },
    },
    '\r\n',
  );
  const raw = Buffer.from(
    first.replace('event: content_block_stop', `${ping}event: content_block_stop`) +
      callFrames({ ...input, model: 'opus', subagent_type: 'multi-zen' }, 'Agent', 1, 'second') +
      verdict,
  );
  const remembered: unknown[] = [];
  const result = await transform(raw, Array(raw.length).fill(1), (...args: unknown[]) => {
    remembered.push(args);
  });
  assert(result.includes(Buffer.from(verdict)));
  assert(result.indexOf(ping) < result.indexOf('partial_json'));
  assert.deepEqual(remembered, [
    ['toolu_named', 'multi-openai', 'gpt-6-luna'],
    ['second', 'multi-zen', 'opus'],
  ]);
  assert.equal(data(result).filter((event) => event.type === 'content_block_stop').length, 2);
});

test('incomplete Agent streams retain buffered frames and trailing bytes', async () => {
  const raw = Buffer.from(`${callFrames().split('event: content_block_stop')[0]}data: unfinished`);
  assert.deepEqual(await transform(raw, Array(raw.length).fill(1)), raw);
});

test('every provider worker strips any string model, while unrelated inputs remain intact', () => {
  for (const provider of ['openai', 'zen', 'cursor', 'antigravity', 'grok']) {
    for (const model of ['gpt-6-luna', 'haiku', 'unknown', '']) {
      const block = tool('Agent', { ...input, subagent_type: `multi-${provider}`, model });
      assert.equal(
        stripWorkerModel(block, () => {}),
        true,
      );
      assert.deepEqual(block.input, { subagent_type: `multi-${provider}`, prompt: input.prompt });
    }
  }
  for (const value of [null, [], 'text', {}, { model: 'haiku' }, { ...input, model: null }]) {
    const block = tool('Agent', value);
    assert.equal(
      stripWorkerModel(block, () => {}),
      false,
    );
    assert.strictEqual(block.input, value);
  }
});

test('JSON and bounded model records preserve untouched content, retry, ownership and fallback', () => {
  const models = new WorkerModels();
  const raw = Buffer.from(
    JSON.stringify({
      content: [tool(), tool('Agent', { ...input, subagent_type: 'Explore' }, 'claude')],
    }),
  );
  const result = JSON.parse(stripWorkerJson(raw, models.remember('s')).toString());
  assert.equal(result.content[0].input.model, undefined);
  assert.equal(result.content[1].input.model, 'gpt-6-luna');
  const spawn = {
    sessionId: 's',
    toolUseId: 'toolu_named',
    subagentType: 'multi-openai',
    model: 'wrong',
  };
  assert.equal(models.selection(spawn).model, 'gpt-6-luna');
  assert.equal(models.selection(spawn).model, 'gpt-6-luna');
  assert.equal(models.selection({ ...spawn, sessionId: 'other' }).model, 'wrong');
  assert.equal(models.selection({ ...spawn, subagentType: 'multi-zen' }).model, 'wrong');
  assert.equal(models.selection({ ...spawn, fork: true }).model, 'wrong');
  stripWorkerModel(tool('Agent', { ...input, model: 'other' }), models.remember('other'));
  assert.equal(models.selection({ ...spawn, sessionId: 'other' }).model, 'other');
  models.forgetSession('s');
  assert.equal(models.selection(spawn).model, 'wrong');
  models.remember('')('unscoped', 'multi-openai', 'fallback');
  assert.equal(models.selection({ ...spawn, toolUseId: 'unscoped' }).model, 'fallback');
  for (let i = 0; i < 2048; i++) {
    models.remember('s')(String(i), 'multi-openai', 'new');
  }
  assert.equal(models.selection({ ...spawn, sessionId: 'other' }).model, 'wrong');
  const untouched = Buffer.from(' { "content": [{"type":"text", "text":"hello"}] } ');
  assert.strictEqual(stripWorkerJson(untouched, models.remember('s')), untouched);
  const malformed = Buffer.from('{bad');
  assert.strictEqual(stripWorkerJson(malformed, models.remember('s')), malformed);
});

const openaiEvents = () =>
  new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_worker',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'toolu_named',
            name: 'Agent',
            arguments: JSON.stringify(input),
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })}\n\n`,
  );

test('built OpenAI stream and saved response share stripped content before verdicts or archival', async () => {
  const models = new WorkerModels();
  const events: unknown[] = [];
  const reply = await fromResponses(
    openaiEvents().body ?? new ReadableStream(),
    'multi/openai/gpt-6-luna',
    (type, value) => {
      events.push({ type, ...value });
    },
    {
      rememberWorkerModel: models.remember('s'),
    },
  );
  assert.equal((reply.content[0] as { input: Record<string, unknown> }).input.model, undefined);
  const saved = JSON.parse(JSON.stringify({ response: reply, events }));
  assert.equal(saved.response.content[0].input.model, undefined);
  const delta = saved.events.find(
    (event: { type: string }) => event.type === 'content_block_delta',
  );
  assert.equal(JSON.parse(delta.delta.partial_json).model, undefined);
  assert.equal(
    models.selection({ sessionId: 's', toolUseId: 'toolu_named', subagentType: 'multi-openai' })
      .model,
    'gpt-6-luna',
  );
});

test('Zen Chat normalizes the same block used by streamed deltas and saved content', async () => {
  const models = new WorkerModels();
  const chunk = {
    id: 'chat-worker',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'toolu_named',
              type: 'function',
              function: { name: 'Agent', arguments: JSON.stringify(input) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
  const upstream = new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  assert(upstream.body);
  const events: unknown[] = [];
  const reply = await fromChat(
    upstream.body,
    'multi/zen/deepseek-v4.1-flash',
    (type, value) => {
      events.push({ type, ...value });
    },
    { rememberWorkerModel: models.remember('s') },
  );
  const saved = JSON.parse(JSON.stringify({ response: reply, events }));
  assert.equal(saved.response.content[0].input.model, undefined);
  const delta = saved.events.find(
    (event: { type: string }) => event.type === 'content_block_delta',
  );
  assert.equal(JSON.parse(delta.delta.partial_json).model, undefined);
  assert.equal(
    models.selection({ sessionId: 's', toolUseId: 'toolu_named', subagentType: 'multi-openai' })
      .model,
    'gpt-6-luna',
  );
});

async function modelReply(response: Response): Promise<{ model?: string }> {
  return (await response.json()) as { model?: string };
}

async function gateway(t: test.TestContext, fetchImpl: GatewayOptions['fetchImpl']) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'worker-model-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'stub', account_id: 'stub' } }),
  );
  const permissionModes = new PermissionModes(async () => ({}), undefined, {
    workers: workerCatalog([
      { model: 'multi/openai/default' },
      { model: 'multi/openai/gpt-6-luna' },
    ]),
  });
  const server = createNativeGateway({ token: 'test', authFile, fetchImpl, permissionModes });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return (route: string, body: object, session = 's') =>
    fetch(`http://127.0.0.1:${address.port}${route}`, {
      method: 'POST',
      headers: { 'x-multi-gateway-token': 'test', 'x-claude-code-session-id': session },
      body: JSON.stringify(body),
    });
}

test('Anthropic JSON relay repairs content-length, scopes route lookup, and leaves errors alone', async (t) => {
  const raw = JSON.stringify({ content: [tool()] });
  let status = 200;
  const post = await gateway(
    t,
    async () =>
      new Response(raw, {
        status,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(raw)),
        },
      }),
  );
  const result = await post('/v1/messages', { model: 'claude-sonnet-5' });
  const body = await result.text();
  assert.equal(result.headers.get('content-length'), String(Buffer.byteLength(body)));
  assert.equal(JSON.parse(body).content[0].input.model, undefined);
  const spawn = {
    sessionId: 's',
    cwd: '/workspace',
    toolUseId: 'toolu_named',
    subagentType: 'multi-openai',
  };
  for (let retry = 0; retry < 2; retry++) {
    assert.equal(
      (await modelReply(await post('/multi/mod/worker-model', spawn))).model,
      'multi/openai/gpt-6-luna',
    );
  }
  assert.equal(
    (await modelReply(await post('/multi/mod/worker-model', { ...spawn, sessionId: 'other' })))
      .model,
    'multi/openai/default',
  );
  status = 400;
  assert.equal(await (await post('/v1/messages', { model: 'claude-sonnet-5' })).text(), raw);
  status = 200;
  assert.equal(
    await (await post('/v1/messages/count_tokens', { model: 'claude-sonnet-5' })).text(),
    raw,
  );
  await (await post('/multi/mod/detach', { sessionId: 's' })).text();
  assert.equal(
    (await modelReply(await post('/multi/mod/worker-model', spawn))).model,
    'multi/openai/default',
  );
});

test('gateway SSE relay and built JSON/SSE retain Agent verdicts and route selections', async (t) => {
  const verdict = frame('message_delta', {
    delta: {
      safeguard_results: [
        { status: { tool_uses: { toolu_named: { type: 'evaluated', outcome: 'not_flagged' } } } },
      ],
    },
  });
  const post = await gateway(t, async (url) =>
    String(url).includes('chatgpt.com')
      ? openaiEvents()
      : new Response(callFrames() + verdict, { headers: { 'content-type': 'text/event-stream' } }),
  );
  for (const model of ['claude-sonnet-5', 'multi/openai/gpt-6-luna']) {
    for (const stream of [false, true]) {
      if (!stream && model.startsWith('claude')) {
        continue;
      }
      const result = await post('/v1/messages', {
        model,
        stream,
        tools: [{ name: 'Agent', input_schema: { type: 'object' } }],
        safeguards: [
          { type: 'dangerous_tool_use', classifier_context: { permission_mode: 'auto' } },
        ],
        messages: [{ role: 'user', content: 'delegate' }],
      });
      assert.equal(result.status, 200);
      const raw = await result.text();
      if (stream) {
        const events = data(Buffer.from(raw));
        assert.equal(
          JSON.parse(
            events.find((event) => event.type === 'content_block_delta').delta.partial_json,
          ).model,
          undefined,
        );
        assert.equal(
          events.find((event) => event.type === 'message_delta').delta.safeguard_results[0].status
            .tool_uses.toolu_named.outcome,
          'not_flagged',
        );
      } else {
        const reply = JSON.parse(raw);
        assert.equal(reply.content[0].input.model, undefined);
        assert.equal(
          reply.safeguard_results[0].status.tool_uses.toolu_named.outcome,
          'not_flagged',
        );
      }
      const resolved = await post('/multi/mod/worker-model', {
        sessionId: 's',
        cwd: '/workspace',
        toolUseId: 'toolu_named',
        subagentType: 'multi-openai',
        model: 'wrong',
      });
      assert.equal((await modelReply(resolved)).model, 'multi/openai/gpt-6-luna');
    }
  }
});

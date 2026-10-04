import assert from 'node:assert/strict';
import test from 'node:test';
import {
  withHandback,
  withoutHarnessHandback,
} from '../../plugins/multi-core/src/gateway/harness-handback.ts';
import {
  continuation,
  harnessHistoryHash,
  historyRewound,
} from '../../plugins/multi-core/src/gateway/harness-notices.ts';
import { HarnessResponse } from '../../plugins/multi-core/src/gateway/harness-response.ts';
import type {
  MessagesRequest,
  MessagesResponse,
} from '../../plugins/multi-core/src/gateway/messages.ts';
import type { NativeHarness } from '../../plugins/multi-core/src/gateway/native-harness.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';

const model = 'multi/cursor/test';
const handback = { name: 'SubagentHandback', input_schema: { type: 'object' } };
const safeguards = [
  { type: 'dangerous_tool_use', classifier_context: { permission_mode: 'auto' } },
];

async function gateway(t: test.TestContext, rows: boolean) {
  let runs = 0;
  let saved: MessagesResponse | undefined;
  const inputs: MessagesRequest[] = [];
  const harness: NativeHarness = {
    validate: () => 1,
    async handle(body, _scope, _signal, emit) {
      inputs.push(body);
      runs++;
      const response = new HarnessResponse(model, 1, emit ?? (() => {}), body.safeguards);
      response.text(`[Cursor] notice\nreport ${runs}`);
      if (rows) {
        response.displayRow({
          type: 'tool_use',
          id: 'toolu_multi_12345678901234567890123456789012',
          name: 'mcp__multi-core__run_command',
          input: {},
        });
        response.text(`\nfinal ${runs}`);
      }
      saved = response.finish(undefined);
      for (const [name, value] of response.takeTerminalEvents()) {
        emit?.(name, value);
      }
      return saved;
    },
    async recordedResponse() {
      return saved;
    },
  };
  const server = createNativeGateway({
    token: 'handback-test',
    authFile: 'unused',
    cursor: harness,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const send = (messages: MessagesRequest['messages'], offered = true, stream = false) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-multi-gateway-token': 'handback-test',
        'x-claude-code-session-id': 'handback-session',
        'x-claude-code-agent-id': 'worker',
      },
      body: JSON.stringify({
        model,
        messages,
        tools: offered ? [handback] : [],
        stream,
        safeguards,
      }),
    });
  return { send, inputs, runs: () => runs, saved: () => saved };
}

function delivery(response: MessagesResponse) {
  const block = response.content.at(-1);
  assert.equal(block?.type, 'tool_use');
  assert.equal(block.name, 'SubagentHandback');
  assert.equal(response.stop_reason, 'tool_use');
  assert.deepEqual(response.safeguard_results?.[0].status.tool_uses[block.id], {
    type: 'evaluated',
    outcome: 'not_flagged',
  });
  return block;
}

function streamEvents(raw: string) {
  return raw
    .split('\n\n')
    .filter((part) => part.startsWith('event: '))
    .map((part) => JSON.parse(part.slice(part.indexOf('data: ') + 6)) as Record<string, unknown>);
}

test('a harness answer without rows sends its full report through handback in JSON and SSE', async (t) => {
  const source = await gateway(t, false);
  const first = (await (
    await source.send([{ role: 'user', content: 'work' }])
  ).json()) as MessagesResponse;
  const block = delivery(first);
  assert.deepEqual(block.input, { message: '[Cursor] notice\nreport 1' });
  assert.deepEqual(source.saved()?.content, [{ type: 'text', text: '[Cursor] notice\nreport 1' }]);
  assert.equal(
    source.inputs[0]?.tools?.length,
    0,
    'the native harness never sees the delivery tool',
  );

  const streamed = await source.send([{ role: 'user', content: 'stream' }], true, true);
  const events = streamEvents(await streamed.text());
  assert.equal(events.filter((event) => event.type === 'message_delta').length, 1);
  const terminal = events.find((event) => event.type === 'message_delta');
  assert.ok(terminal);
  assert.equal((terminal.delta as { stop_reason: string }).stop_reason, 'tool_use');
  assert.equal(events.filter((event) => event.type === 'content_block_start').length, 2);
  const inputDelta = events.find(
    (event) =>
      event.type === 'content_block_delta' &&
      (event.delta as { type?: string }).type === 'input_json_delta',
  );
  assert.ok(inputDelta);
  assert.deepEqual(JSON.parse((inputDelta.delta as { partial_json: string }).partial_json), {
    message: '[Cursor] notice\nreport 2',
  });
});

test('rows defer the delivery to the follow-up, including streamed follow-ups', async (t) => {
  const source = await gateway(t, true);
  const first = (await (
    await source.send([{ role: 'user', content: 'work' }])
  ).json()) as MessagesResponse;
  assert.equal(first.stop_reason, 'end_turn');
  assert.equal(
    first.content.some((block) => block.type === 'tool_use' && block.name === 'SubagentHandback'),
    false,
  );
  const row = first.content.find((block) => block.type === 'tool_use');
  assert.ok(row?.type === 'tool_use');
  const messages = [
    { role: 'user', content: 'work' },
    { role: 'assistant', content: first.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: row.id, content: 'done' }] },
  ];
  const followed = (await (await source.send(messages)).json()) as MessagesResponse;
  assert.equal((delivery(followed).input as { message: string }).message, '\nfinal 1');
  const events = streamEvents(await (await source.send(messages, true, true)).text());
  const terminal = events.find((event) => event.type === 'message_delta');
  assert.ok(terminal);
  assert.equal((terminal.delta as { stop_reason: string }).stop_reason, 'tool_use');
  assert.equal(events.filter((event) => event.type === 'content_block_start').length, 2);
  assert.equal(source.runs(), 1);

  const recorded = source.saved();
  const handbackBlock = delivery(followed);
  await source.send([
    ...messages,
    { role: 'assistant', content: followed.content },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: handbackBlock.id, content: 'delivered' }],
    },
    { role: 'user', content: 'next task' },
  ]);
  const resumed = source.inputs.at(-1);
  assert.ok(resumed);
  assert.equal(
    historyRewound({ response: recorded }, resumed.messages ?? [], harnessHistoryHash),
    false,
  );
  assert.deepEqual(continuation(resumed, 'Cursor'), [
    { role: 'user', content: [{ type: 'text', text: 'next task' }] },
  ]);
  assert.equal(source.runs(), 2);
});

test('handback result and enforcement bounce are answered locally; resume strips delivery history', async (t) => {
  const source = await gateway(t, false);
  const first = (await (
    await source.send([{ role: 'user', content: 'work' }])
  ).json()) as MessagesResponse;
  const block = delivery(first);
  const history = [
    { role: 'user', content: 'work' },
    { role: 'assistant', content: first.content },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: block.id, content: 'delivered' }],
    },
  ];
  const resultOnly = (await (await source.send(history)).json()) as MessagesResponse;
  assert.equal(
    (delivery(resultOnly).input as { message: string }).message,
    '[Cursor] notice\nreport 1',
  );
  const bounced = (await (
    await source.send([
      { role: 'user', content: 'work' },
      { role: 'user', content: '[handback-send-enforce] Your report has not been delivered.' },
    ])
  ).json()) as MessagesResponse;
  assert.equal(
    (delivery(bounced).input as { message: string }).message,
    '[Cursor] notice\nreport 1',
  );
  assert.equal(source.runs(), 1);

  const recorded = source.saved();
  await source.send([...history, { role: 'user', content: 'next task' }]);
  const resumed = source.inputs.at(-1);
  assert.ok(resumed);
  assert.equal(
    historyRewound({ response: recorded }, resumed.messages ?? [], harnessHistoryHash),
    false,
  );
  assert.deepEqual(continuation(resumed, 'Cursor'), [
    { role: 'user', content: [{ type: 'text', text: 'next task' }] },
  ]);
  assert.equal(JSON.stringify(resumed.messages).includes('SubagentHandback'), false);
  assert.equal(JSON.stringify(resumed.messages).includes('tool_result'), false);
  assert.equal(source.runs(), 2);
});

test('without an offered handback tool, the harness answer stays an end turn', async (t) => {
  const source = await gateway(t, false);
  const response = (await (
    await source.send([{ role: 'user', content: 'work' }], false)
  ).json()) as MessagesResponse;
  assert.equal(response.stop_reason, 'end_turn');
  assert.deepEqual(response.content, [{ type: 'text', text: '[Cursor] notice\nreport 1' }]);
});

test('an enforcement bounce with no recorded answer fails before native dispatch', async (t) => {
  const source = await gateway(t, false);
  const reply = await source.send([
    { role: 'user', content: '[handback-send-enforce] Call SubagentHandback now.' },
  ]);
  assert.equal(reply.status, 400);
  assert.match(await reply.text(), /No recorded harness report/);
  assert.equal(source.runs(), 0);
});

test('an empty native answer gets a report and remains a resumable assistant turn', () => {
  const recorded: MessagesResponse = {
    id: 'msg_empty',
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  };
  const delivered = withHandback(recorded, '', safeguards);
  const block = delivery(delivered);
  assert.deepEqual(block.input, { message: 'Native run finished.' });
  const next = withoutHarnessHandback({
    model,
    tools: [handback],
    messages: [
      { role: 'user', content: 'work' },
      { role: 'assistant', content: delivered.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content: 'done' }] },
      { role: 'user', content: 'next' },
    ],
  });
  assert.equal(
    historyRewound({ response: recorded }, next.messages ?? [], harnessHistoryHash),
    false,
  );
  assert.deepEqual(continuation(next, 'Cursor'), [
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ]);
});

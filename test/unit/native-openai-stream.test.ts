import assert from 'node:assert/strict';
import test from 'node:test';
import type { Emit, StreamEventBody } from '../../plugins/multi-core/src/gateway/messages.ts';
import { safeguardResults } from '../../plugins/multi-core/src/gateway/safeguards.ts';
import { fromResponses, toResponses } from '../../plugins/multi-openai/src/responses.ts';

const model = 'multi/openai/gpt-6-astra';
const created = { type: 'response.created', response: { id: 'resp' } };
const tool = {
  type: 'function_call',
  id: 'fc_a',
  call_id: 'call_a',
  name: 'Read',
  arguments: '{"file_path":"a"}',
};
const text = {
  type: 'message',
  id: 'msg_a',
  content: [{ type: 'output_text', text: 'prefix suffix' }],
};
const reasoning = {
  type: 'reasoning',
  id: 'rs_a',
  summary: [{ type: 'summary_text', text: 'Checking' }],
  encrypted_content: 'opaque',
};
const terminal = (output?: unknown[], type = 'response.completed') => ({
  type,
  response: {
    id: 'resp',
    output,
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20 },
  },
});
const itemEvent = (type: 'added' | 'done', item: unknown, output_index = 0) => ({
  type: `response.output_item.${type}`,
  output_index,
  item,
});
async function* stream(events: unknown[]) {
  for (const event of events) {
    yield Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
  }
}
const translate = (events: unknown[], emit?: Emit) =>
  fromResponses(stream(events), model, emit, { toolNames: new Map([['Read', 'Read']]) });

function capture() {
  const events: { type: string; value: StreamEventBody }[] = [];
  const emit: Emit = (type, value) => {
    events.push({ type, value });
  };
  return { events, emit };
}

test('terminal-only text, reasoning and tool calls are recovered with usage and reusable state', async () => {
  for (const type of ['response.completed', 'response.done']) {
    const result = await translate([created, terminal([text, reasoning, tool], type)]);
    assert.deepEqual(
      result.content.map((block) => block.type),
      ['text', 'thinking', 'tool_use'],
    );
    assert.equal(result.stop_reason, 'tool_use');
    assert.deepEqual(result.usage, {
      input_tokens: 60,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
      output_tokens: 20,
    });
    const next = toResponses(
      { messages: [{ role: 'assistant', content: result.content }] },
      'gpt-6-astra',
    );
    assert(
      next.input.some((item) => 'encrypted_content' in item && item.encrypted_content === 'opaque'),
    );
  }
});

test('message_start carries the local input estimate until the provider reports real usage', async () => {
  const { events, emit } = capture();
  await fromResponses(stream([created, terminal([text])]), model, emit, { inputTokens: 1234 });
  const bodies = Object.fromEntries(events.map((event) => [event.type, event.value]));
  const start = bodies.message_start as { message: { usage: unknown } };
  assert.deepEqual(start.message.usage, { input_tokens: 1234, output_tokens: 0 });
  const delta = bodies.message_delta as { usage: unknown };
  assert.deepEqual(delta.usage, {
    input_tokens: 60,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
    output_tokens: 20,
  });
});

test('OpenAI reports unavailable per tool and an empty map without tools, including buffered replies', async () => {
  const safeguards = [
    { type: 'dangerous_tool_use', classifier_context: { permission_mode: 'auto' } },
  ];
  const seen = capture();
  const result = await fromResponses(stream([created, terminal([tool])]), model, seen.emit, {
    safeguards,
  });
  const expected = [
    {
      type: 'dangerous_tool_use',
      status: {
        type: 'available',
        tool_uses: { call_a: { type: 'unavailable', reason: 'error' } },
      },
    },
  ];
  assert.deepEqual(result.safeguard_results, expected);
  const delta = seen.events.find((event) => event.type === 'message_delta')?.value;
  assert.deepEqual((delta as { delta?: unknown } | undefined)?.delta, {
    stop_reason: 'tool_use',
    stop_sequence: null,
    safeguard_results: expected,
  });
  const empty = await fromResponses(stream([created, terminal([text])]), model, undefined, {
    safeguards,
  });
  assert.deepEqual(empty.safeguard_results?.[0].status.tool_uses, {});
  for (const malformed of [undefined, {}, [null], [{ type: 'dangerous_tool_use' }, 7]]) {
    const omitted = await fromResponses(stream([created, terminal([tool])]), model, undefined, {
      safeguards: malformed,
    });
    assert.equal(omitted.safeguard_results, undefined);
  }
});

test('Zen Responses uses Zen verdicts instead of OpenAI review fallback', async () => {
  const result = await fromResponses(stream([created, terminal([tool])]), model, undefined, {
    safeguards: [{ type: 'dangerous_tool_use', classifier_context: { permission_mode: 'plan' } }],
    safeguardProvider: 'zen',
  });
  assert.deepEqual(result.safeguard_results, [
    {
      type: 'dangerous_tool_use',
      status: {
        type: 'available',
        tool_uses: {
          call_a: {
            type: 'evaluated',
            outcome: 'flagged',
            explanation: 'Plan mode: Zen has no reviewer, so actions that need review are refused.',
          },
        },
      },
    },
  ]);
});

test('a __proto__ tool ID remains an own property after safeguard serialization', () => {
  const result = safeguardResults(
    [{ type: 'dangerous_tool_use' }],
    [{ type: 'tool_use', id: '__proto__', name: 'Read', input: {} }],
    'openai',
  );
  const encoded = JSON.stringify(result);
  const decoded = JSON.parse(encoded) as [{ status: { tool_uses: Record<string, unknown> } }];
  assert.equal(Object.hasOwn(decoded[0].status.tool_uses, '__proto__'), true);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(decoded[0].status.tool_uses, '__proto__')?.value,
    {
      type: 'unavailable',
      reason: 'error',
    },
  );
});

test('terminal output finishes partial arguments and interleaved calls in output order exactly once', async () => {
  const seen = capture();
  const second = { ...tool, id: 'fc_b', call_id: 'call_b', arguments: '{"file_path":"b"}' };
  const result = await translate(
    [
      created,
      itemEvent('added', { type: 'function_call', id: 'fc_a' }),
      itemEvent('added', second, 1),
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"file_path":' },
      itemEvent('done', second, 1),
      terminal([tool, second]),
    ],
    seen.emit,
  );
  assert.deepEqual(
    result.content.map((block) => block.type === 'tool_use' && block.input),
    [{ file_path: 'a' }, { file_path: 'b' }],
  );
  assert.equal(seen.events.filter((event) => event.type === 'content_block_start').length, 2);
  assert.equal(seen.events.filter((event) => event.type === 'message_stop').length, 1);
});

test('terminal confirmation of already streamed calls does not emit duplicate tools', async () => {
  const seen = capture();
  await translate(
    [created, itemEvent('added', tool), itemEvent('done', tool), terminal([tool])],
    seen.emit,
  );
  assert.equal(seen.events.filter((event) => event.type === 'content_block_start').length, 1);
});

test('a terminal text suffix is emitted without repeating its streamed prefix', async () => {
  const seen = capture();
  const result = await translate(
    [
      created,
      itemEvent('added', { type: 'message', id: 'msg_a' }),
      { type: 'response.output_text.delta', output_index: 0, delta: 'prefix' },
      terminal([text]),
    ],
    seen.emit,
  );
  assert.deepEqual(result.content, [{ type: 'text', text: 'prefix suffix' }]);
  const deltas = seen.events.flatMap((event) =>
    'delta' in event.value && 'text' in event.value.delta ? [event.value.delta.text] : [],
  );
  assert.deepEqual(deltas, ['prefix', ' suffix']);
});

test('missing added events and earlier missing indices recover in index order', async () => {
  const result = await translate([created, itemEvent('done', tool, 1), terminal([text, tool])]);
  assert.deepEqual(
    result.content.map((block) => block.type),
    ['text', 'tool_use'],
  );
  const doneOnly = await translate([created, itemEvent('done', text), terminal([])]);
  assert.deepEqual(doneOnly.content, [{ type: 'text', text: 'prefix suffix' }]);
});

test('reasoning prefers final encrypted state and retains early state only when final omits it', async () => {
  for (const final of [reasoning, { type: 'reasoning', id: 'rs_a' }]) {
    const result = await translate([
      created,
      itemEvent('added', { ...reasoning, encrypted_content: 'early' }),
      itemEvent('done', final),
      terminal([final]),
    ]);
    const next = toResponses(
      { messages: [{ role: 'assistant', content: result.content }] },
      'gpt-6-astra',
    );
    const restored = next.input[0];
    assert('encrypted_content' in restored);
    assert.equal(restored.encrypted_content, 'encrypted_content' in final ? 'opaque' : 'early');
  }
  await assert.rejects(
    translate([created, terminal([{ type: 'reasoning' }])]),
    /omitted encrypted/,
  );
});

test('terminal reasoning ciphertext may rotate without changing visible reasoning or emitted state', async () => {
  const seen = capture();
  const result = await translate(
    [
      created,
      itemEvent('added', reasoning),
      itemEvent('done', reasoning),
      terminal([{ ...reasoning, encrypted_content: 'rotated' }]),
    ],
    seen.emit,
  );
  const next = toResponses(
    { messages: [{ role: 'assistant', content: result.content }] },
    'gpt-6-astra',
  );
  assert('encrypted_content' in next.input[0]);
  assert.equal(next.input[0].encrypted_content, 'opaque');
  assert(seen.events.some((event) => event.type === 'message_stop'));
  const changed = { ...reasoning, summary: [{ type: 'summary_text', text: 'Changed' }] };
  await assert.rejects(
    translate([created, itemEvent('done', reasoning), terminal([changed])]),
    /changed a completed item/,
  );
});

test('terminal conflicts never emit a successful completion or a replacement tool', async () => {
  for (const changed of [
    { ...tool, arguments: '{"file_path":"changed"}' },
    { ...tool, call_id: 'different' },
    { ...tool, name: 'Edit' },
    { ...tool, id: 'different' },
    text,
  ]) {
    const seen = capture();
    await assert.rejects(
      translate(
        [created, itemEvent('added', tool), itemEvent('done', tool), terminal([changed])],
        seen.emit,
      ),
      /changed/,
    );
    assert.equal(seen.events.filter((event) => event.type === 'content_block_start').length, 1);
    assert.equal(seen.events.filter((event) => event.type === 'message_stop').length, 0);
  }
});

test('malformed terminal output and unfinished or absent content fail explicitly', async () => {
  for (const events of [
    [created, terminal([{ type: 'unknown' }])],
    [created, terminal([{ ...tool, arguments: '[]' }])],
    [created, terminal([{ ...tool, name: 'NotDeclared' }])],
    [created, terminal([tool, { ...tool, id: 'fc_b' }])],
    [created, terminal([{ ...text, content: [{ type: 'output_text', text: 42 }] }])],
    [created, terminal([])],
    [created, itemEvent('added', tool), terminal()],
    [created, itemEvent('done', tool, 1), terminal()],
    [created, itemEvent('done', text, 1), terminal([text])],
  ]) {
    await assert.rejects(translate(events));
  }
});

test('terminal data must extend previously streamed text and arguments', async () => {
  await assert.rejects(
    translate([
      created,
      itemEvent('added', { type: 'message' }),
      { type: 'response.output_text.delta', output_index: 0, delta: 'different' },
      terminal([text]),
    ]),
    /text changed/,
  );
  await assert.rejects(
    translate([
      created,
      itemEvent('added', { type: 'function_call' }),
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"other":' },
      terminal([tool]),
    ]),
    /arguments changed/,
  );
});

test('terminal status and incomplete reason remain authoritative during recovery', async () => {
  const event = terminal([text], 'response.done');
  const result = await translate([
    created,
    {
      ...event,
      response: {
        ...event.response,
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    },
  ]);
  assert.equal(result.stop_reason, 'max_tokens');
  for (const status of ['failed', 'cancelled', 'in_progress']) {
    await assert.rejects(
      translate([created, { ...event, response: { ...event.response, status } }]),
      /terminal response/,
    );
  }
  await assert.rejects(
    translate([
      created,
      {
        ...event,
        response: {
          ...event.response,
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
        },
      },
    ]),
    /incomplete/,
  );
});

test('terminal-only stop sequences suppress subsequent tools', async () => {
  const result = await fromResponses(stream([terminal([text, tool])]), model, undefined, {
    toolNames: new Map([['Read', 'Read']]),
    stopSequences: [' suffix'],
  });
  assert.equal(result.stop_reason, 'stop_sequence');
  assert.deepEqual(result.content, [{ type: 'text', text: 'prefix' }]);
});

test('an early null reasoning snapshot can be replaced by final encrypted state', async () => {
  const result = await translate([
    created,
    itemEvent('added', { ...reasoning, encrypted_content: null }),
    terminal([reasoning, text]),
  ]);
  assert.equal(result.content[0]?.type, 'thinking');
  assert.equal(result.stop_reason, 'end_turn');
});

test('a stop sequence hit mid-stream still waits for the terminal event to record billed usage', async () => {
  const delta = (value: string) => ({
    type: 'response.output_text.delta',
    output_index: 0,
    delta: value,
  });
  const { events, emit } = capture();
  const result = await fromResponses(
    stream([
      created,
      itemEvent('added', { type: 'message', id: 'msg_a', content: [] }),
      delta('prefix'),
      delta(' suffix'),
      delta(' ignored after the stop'),
      terminal([text]),
    ]),
    model,
    emit,
    { stopSequences: [' suffix'] },
  );
  assert.equal(result.stop_reason, 'stop_sequence');
  assert.deepEqual(result.content, [{ type: 'text', text: 'prefix' }]);
  assert.deepEqual(result.usage, {
    input_tokens: 60,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
    output_tokens: 20,
  });
  assert.equal(result.multi_usage?.source, 'provider');
  assert.equal(events.filter((event) => event.type === 'message_stop').length, 1);
});

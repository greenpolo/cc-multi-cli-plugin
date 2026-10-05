import assert from 'node:assert/strict';
import test from 'node:test';
import type { Emit, StreamEventBody } from '../../plugins/multi-core/src/gateway/messages.ts';
import { toolName } from '../../plugins/multi-core/src/gateway/tools.ts';
import { fromChat, toChat } from '../../plugins/multi-zen/src/chat.ts';

const model = 'multi/zen/kimi-k3';
const tools = [{ name: 'Read File', description: 'read', input_schema: { type: 'object' } }];
const readAlias = toolName('Read File');

async function* sse(events: unknown[]) {
  for (const event of events) {
    yield Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
  }
  yield Buffer.from('data: [DONE]\n\n');
}

function capture() {
  const events: { type: string; value: StreamEventBody }[] = [];
  const emit: Emit = (type, value) => events.push({ type, value });
  return { events, emit };
}

test('Chat reports the final usage snapshot without summing or retaining stale maxima', async () => {
  const result = await fromChat(
    sse([
      {
        id: 'usage_snapshot',
        choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 80 },
      },
      {
        id: 'usage_snapshot',
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 18, cached_tokens: 60 },
      },
    ]),
    model,
  );
  assert.deepEqual(result.usage, {
    input_tokens: 40,
    output_tokens: 18,
    cache_read_input_tokens: 60,
    cache_creation_input_tokens: 0,
  });
});

test('Zen Chat reports auto, plan, and missing-mode safeguard verdicts', async () => {
  const events = [
    {
      id: 'chat-safeguard',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call-a', function: { name: readAlias, arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    { id: 'chat-safeguard', choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
  ];
  const cases = [
    ['auto', { type: 'evaluated', outcome: 'not_flagged' }],
    ['default', { type: 'evaluated', outcome: 'not_flagged' }],
    ['acceptEdits', { type: 'evaluated', outcome: 'not_flagged' }],
    ['dontAsk', { type: 'evaluated', outcome: 'not_flagged' }],
    ['bypassPermissions', { type: 'evaluated', outcome: 'not_flagged' }],
    [
      'plan',
      {
        type: 'evaluated',
        outcome: 'flagged',
        explanation: 'Plan mode: Zen has no reviewer, so actions that need review are refused.',
      },
    ],
    [
      undefined,
      {
        type: 'evaluated',
        outcome: 'flagged',
        explanation:
          'Zen permission mode is unavailable or unknown, so actions that need review are refused.',
      },
    ],
    [
      'unknown',
      {
        type: 'evaluated',
        outcome: 'flagged',
        explanation:
          'Zen permission mode is unavailable or unknown, so actions that need review are refused.',
      },
    ],
    [
      'bypass',
      {
        type: 'evaluated',
        outcome: 'flagged',
        explanation:
          'Zen permission mode is unavailable or unknown, so actions that need review are refused.',
      },
    ],
    [
      '',
      {
        type: 'evaluated',
        outcome: 'flagged',
        explanation:
          'Zen permission mode is unavailable or unknown, so actions that need review are refused.',
      },
    ],
  ] as const;
  for (const [mode, verdict] of cases) {
    const seen = capture();
    const result = await fromChat(sse(events), model, seen.emit, {
      safeguards: [{ type: 'dangerous_tool_use', classifier_context: { permission_mode: mode } }],
      toolNames: new Map([[readAlias, 'Read File']]),
    });
    const expected = [
      {
        type: 'dangerous_tool_use',
        status: { type: 'available', tool_uses: { 'call-a': verdict } },
      },
    ];
    assert.deepEqual(result.safeguard_results, expected);
    const delta = seen.events.find((event) => event.type === 'message_delta')?.value;
    assert.deepEqual(
      (delta as { delta?: { safeguard_results?: unknown } } | undefined)?.delta?.safeguard_results,
      expected,
    );
  }
  const missing = await fromChat(sse(events), model, undefined, { safeguards: [null] });
  assert.equal(missing.safeguard_results, undefined);
  const absent = await fromChat(sse(events), model);
  assert.equal(absent.safeguard_results, undefined);
  const textOnly = await fromChat(
    sse([
      {
        id: 'chat-text-safeguard',
        choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      },
    ]),
    model,
    undefined,
    { safeguards: [{ type: 'dangerous_tool_use' }] },
  );
  assert.deepEqual(textOnly.safeguard_results?.[0].status.tool_uses, {});
});

test('toChat keeps assistant call groups and only replays own model reasoning', () => {
  const own = {
    type: 'thinking',
    thinking: '',
    signature: 'multi-zen-chat:kimi-k3:eyJyZWFzb25pbmciOiIifQ',
  };
  const body = toChat(
    {
      system: 'system',
      tools,
      messages: [
        {
          role: 'assistant',
          content: [
            own,
            { type: 'text', text: 'call' },
            { type: 'tool_use', id: 'call', name: 'Read File', input: { path: 'a' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'ok' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'foreign', signature: 'multi-openai:x' },
            { type: 'text', text: 'done' },
          ],
        },
      ],
    },
    'kimi-k3',
  );
  assert.deepEqual(body.messages[1], {
    role: 'assistant',
    content: 'call',
    tool_calls: [
      { id: 'call', type: 'function', function: { name: readAlias, arguments: '{"path":"a"}' } },
    ],
    reasoning_content: '',
  });
  assert.deepEqual(body.messages[2], { role: 'tool', tool_call_id: 'call', content: 'ok' });
  assert.deepEqual(body.messages[3], { role: 'assistant', content: 'done' });
  const filtered = toChat(
    {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'foreign', signature: 'multi-openai:x' }],
        },
        { role: 'user', content: 'next' },
      ],
    },
    'kimi-k3',
  );
  assert.deepEqual(filtered.messages, [{ role: 'user', content: 'next' }]);
  assert.throws(
    () =>
      toChat(
        {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'thinking', signature: 'multi-zen-chat:kimi-k3:not-base64' }],
            },
          ],
        },
        'kimi-k3',
      ),
    /reasoning signature/,
  );
});

test('fromChat streams reasoning, text and interleaved tools with complete cached usage once', async () => {
  const seen = capture();
  const result = await fromChat(
    sse([
      {
        id: 'chat-1',
        choices: [{ index: 0, delta: { reasoning_content: '' }, finish_reason: null }],
      },
      {
        id: 'chat-1',
        choices: [{ index: 0, delta: { reasoning_content: 'think' }, finish_reason: null }],
      },
      {
        id: 'chat-1',
        choices: [
          {
            index: 0,
            delta: {
              content: 'read',
              tool_calls: [
                {
                  index: 0,
                  id: 'call',
                  type: 'function',
                  function: { name: readAlias, arguments: '{"path":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chat-1',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 40, cache_creation_input_tokens: 10 },
        },
      },
      {
        id: 'chat-1',
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 40, cache_creation_input_tokens: 10 },
        },
      },
    ]),
    model,
    seen.emit,
    { toolNames: new Map([[readAlias, 'Read File']]) },
  );
  assert.deepEqual(
    result.content.map((block) => block.type),
    ['thinking', 'text', 'tool_use'],
  );
  assert.equal(result.content[2]?.type === 'tool_use' ? result.content[2].name : '', 'Read File');
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.usage, {
    input_tokens: 50,
    output_tokens: 8,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 10,
  });
  assert.equal(seen.events.filter((event) => event.type === 'message_stop').length, 1);
  assert.equal(seen.events.filter((event) => event.type === 'content_block_start').length, 3);
});

test('fromChat rejects unknown tools, malformed terminal calls and an interrupted iterable', async () => {
  const base = {
    id: 'chat-1',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: 'call', function: { name: 'missing', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
  await assert.rejects(
    fromChat(sse([base]), model, undefined, { toolNames: new Map([['known', 'known']]) }),
    /undeclared/,
  );
  await assert.rejects(
    fromChat(
      sse([
        {
          id: 'chat-1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call', function: { name: 'missing', arguments: '{' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        { id: 'chat-1', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
      model,
    ),
    /invalid tool arguments/,
  );
  async function* interrupted() {
    yield Buffer.from(
      'data: {"id":"chat-1","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n',
    );
  }
  await assert.rejects(fromChat(interrupted(), model), /ended before completion/);
});

test('fromChat keeps fragmented interleaved tool arguments and rejects data after finish', async () => {
  const seen = capture();
  const result = await fromChat(
    sse([
      {
        id: 'chat-2',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, id: 'b', function: { name: readAlias, arguments: '{"path":' } },
                { index: 0, id: 'a', function: { name: readAlias, arguments: '{"path":' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chat-2',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: '"b"}' } },
                { index: 0, function: { arguments: '"a"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { id: 'chat-2', choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
    ]),
    model,
    seen.emit,
    { toolNames: new Map([[readAlias, 'Read File']]) },
  );
  assert.deepEqual(
    result.content.filter((block) => block.type === 'tool_use').map((block) => block.input),
    [{ path: 'a' }, { path: 'b' }],
  );
  assert.deepEqual(
    seen.events
      .filter((event) => event.type === 'content_block_start')
      .map((event) => ('content_block' in event.value ? event.value.content_block : null))
      .map((block) => (block?.type === 'tool_use' ? block.name : null)),
    ['Read File', 'Read File'],
  );
  await assert.rejects(
    fromChat(
      sse([
        {
          id: 'chat-3',
          choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
        },
        { id: 'chat-3', choices: [{ index: 0, delta: { content: 'late' }, finish_reason: null }] },
      ]),
      model,
    ),
    /after completion/,
  );
});

test('fromChat treats null tool metadata as omitted fields in fragmented deltas', async () => {
  const result = await fromChat(
    sse([
      {
        id: 'chat-null',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '{"path":' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chat-null',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call-null', function: { name: readAlias, arguments: null } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chat-null',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '"a"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { id: 'chat-null', choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } },
    ]),
    model,
    undefined,
    { toolNames: new Map([[readAlias, 'Read File']]) },
  );
  assert.deepEqual(result.content.at(-1), {
    type: 'tool_use',
    id: 'call-null',
    name: 'Read File',
    input: { path: 'a' },
  });
});

test('fromChat rejects impossible cache counts and propagates an aborted iterable', async () => {
  await assert.rejects(
    fromChat(
      sse([
        {
          id: 'chat-4',
          choices: [],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 1,
            prompt_tokens_details: { cached_tokens: 5 },
          },
        },
      ]),
      model,
    ),
    /usage/,
  );
  async function* aborted() {
    yield Buffer.from(
      'data: {"id":"chat-5","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    );
    throw new Error('aborted by caller');
  }
  await assert.rejects(fromChat(aborted(), model), /aborted by caller/);
});

test('toChat preserves image bearing tool output as OpenAI content parts', () => {
  const body = toChat(
    {
      tools,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call',
              content: [
                { type: 'image', source: { type: 'url', url: 'https://example.com/out.png' } },
              ],
            },
          ],
        },
      ],
    },
    'kimi-k3',
  );
  assert.deepEqual(body.messages[0], {
    role: 'tool',
    tool_call_id: 'call',
    content: [{ type: 'image_url', image_url: { url: 'https://example.com/out.png' } }],
  });
});

test('fromChat buffers stop sequence prefixes and never emits the stop suffix', async () => {
  const seen = capture();
  const result = await fromChat(
    sse([
      {
        id: 'chat-stop',
        choices: [{ index: 0, delta: { content: 'before ST' }, finish_reason: null }],
      },
      {
        id: 'chat-stop',
        choices: [{ index: 0, delta: { content: 'OP after' }, finish_reason: null }],
      },
      {
        id: 'chat-stop',
        choices: [
          {
            index: 0,
            delta: {
              content: 'late',
              reasoning_content: 'ignored',
              tool_calls: [
                { index: 0, id: 'late', function: { name: readAlias, arguments: '{}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { id: 'chat-stop', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'chat-stop', choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } },
    ]),
    model,
    seen.emit,
    { stopSequences: ['STOP'] },
  );
  assert.deepEqual(result.content, [{ type: 'text', text: 'before ' }]);
  assert.deepEqual(
    seen.events.flatMap((event) =>
      'delta' in event.value && 'text' in event.value.delta ? [event.value.delta.text] : [],
    ),
    ['before '],
  );
  assert.equal(result.stop_reason, 'stop_sequence');
});

test('fromChat flushes a held stop prefix when the stop sequence never completes', async () => {
  const result = await fromChat(
    sse([
      {
        id: 'chat-held',
        choices: [{ index: 0, delta: { content: 'hello aaa' }, finish_reason: 'stop' }],
      },
      { id: 'chat-held', choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } },
    ]),
    model,
    undefined,
    { stopSequences: ['aaaaX'] },
  );
  assert.deepEqual(result.content, [{ type: 'text', text: 'hello aaa' }]);
});

test('fromChat rejects a tool finish without calls and normalizes tools on stop', async () => {
  await assert.rejects(
    fromChat(
      sse([
        {
          id: 'chat-no-tool',
          choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'tool_calls' }],
        },
        { id: 'chat-no-tool', choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } },
      ]),
      model,
    ),
    /promised tool calls/,
  );
  const result = await fromChat(
    sse([
      {
        id: 'chat-normalize',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call-normalize', function: { name: readAlias, arguments: '{}' } },
              ],
            },
            finish_reason: 'stop',
          },
        ],
      },
      { id: 'chat-normalize', choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } },
    ]),
    model,
    undefined,
    { toolNames: new Map([[readAlias, 'Read File']]) },
  );
  assert.equal(result.stop_reason, 'tool_use');
});

test('fromChat emits strictly sequential blocks, one per reasoning or text segment', async () => {
  const seen = capture();
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: 'chat-seq',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const result = await fromChat(
    sse([
      chunk({ reasoning_content: 'one' }),
      chunk({ content: 'say' }),
      chunk({ reasoning_content: 'two' }),
      chunk({ content: 'more' }, 'stop'),
      { id: 'chat-seq', choices: [], usage: { prompt_tokens: 5, completion_tokens: 4 } },
    ]),
    model,
    seen.emit,
  );
  assert.deepEqual(
    result.content.map((block) => block.type),
    ['thinking', 'text', 'thinking', 'text'],
  );
  assert.equal(result.content[2]?.type === 'thinking' ? result.content[2].thinking : '', 'two');
  const order = seen.events
    .filter((event) => event.type.startsWith('content_block_s'))
    .map((event) => `${event.type}:${(event.value as { index: number }).index}`);
  assert.deepEqual(order, [
    'content_block_start:0',
    'content_block_stop:0',
    'content_block_start:1',
    'content_block_stop:1',
    'content_block_start:2',
    'content_block_stop:2',
    'content_block_start:3',
    'content_block_stop:3',
  ]);
});

test('toChat joins separate system and user text blocks with a newline', () => {
  const request = toChat(
    {
      model,
      system: [
        { type: 'text', text: 'first rule' },
        { type: 'text', text: 'second rule' },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'alpha' },
            { type: 'text', text: 'beta' },
          ],
        },
      ],
    } as never,
    'kimi-k3',
  ) as { messages: { role: string; content: unknown }[] };
  assert.equal(request.messages[0]?.content, 'first rule\nsecond rule');
  assert.equal(request.messages[1]?.content, 'alpha\nbeta');
});

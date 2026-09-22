import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { AgentCatalog } from '../../plugins/multi-core/src/gateway/agent-catalog.ts';
import type { GatewayFetch } from '../../plugins/multi-core/src/gateway/fetch.ts';
import type {
  MessagesRequest,
  MessagesResponse,
  RequestMessage,
  StreamEventBody,
  StreamEventName,
} from '../../plugins/multi-core/src/gateway/messages.ts';
import { ReceiptLedger } from '../../plugins/multi-core/src/gateway/receipts.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import { estimateInputTokens } from '../../plugins/multi-core/src/gateway/tokens.ts';
import {
  originalToolNames,
  toolName,
  callId as wireCallId,
} from '../../plugins/multi-core/src/gateway/tools.ts';
import { readCodexAuth } from '../../plugins/multi-openai/src/auth.ts';
import { openaiInstructions } from '../../plugins/multi-openai/src/instructions.ts';
import { OPENAI_WORKERS } from '../../plugins/multi-openai/src/models.ts';
import type {
  ResponsesInputContent,
  ResponsesInputItem,
  ResponsesRequest,
} from '../../plugins/multi-openai/src/responses.ts';
import {
  forAnthropic,
  fromResponses,
  readSse,
  toResponses,
} from '../../plugins/multi-openai/src/responses.ts';
import { removeTemporary } from '../temporary.ts';

/** A test double for one OpenAI Responses SSE event; sent as JSON, never typed upstream. */
interface SseEvent {
  type: string;
  [field: string]: unknown;
}

const model = 'multi/openai/gpt-6-astra';
const messages: RequestMessage[] = [{ role: 'user', content: 'Read the fixture' }];
const body: MessagesRequest = {
  model,
  system: [{ type: 'text', text: 'Follow the task', cache_control: { type: 'ephemeral' } }],
  messages,
  tools: [
    {
      name: 'Read',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
    },
  ],
};
const sse = (list: SseEvent[]) =>
  list.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('');
const stream = (list: SseEvent[]) => {
  const body = new Response(sse(list)).body;
  assert(body, 'Response body');
  return body;
};
function events(item: SseEvent, deltas: SseEvent[] = []): SseEvent[] {
  return [
    { type: 'response.created', response: { id: 'resp_test', usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    ...deltas.map((delta) => ({ output_index: 0, ...delta })),
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_test',
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 40 },
          output_tokens: 15,
        },
      },
    },
  ];
}
const textEvents = events({ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }, [
  { type: 'response.output_text.delta', delta: 'Done' },
]);
const callId = (item: ResponsesInputItem): string | undefined =>
  'call_id' in item ? item.call_id : undefined;
const contentOf = (item: ResponsesInputItem): ResponsesInputContent[] =>
  'content' in item ? item.content : [];
function isMessagesResponse(value: unknown): value is MessagesResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    Array.isArray(value.content)
  );
}
const readMessage = async (response: Response): Promise<MessagesResponse> => {
  const result = await response.json();
  assert(isMessagesResponse(result), 'Gateway answered with a Messages response');
  return result;
};
const textOf = (result: MessagesResponse): string | undefined => {
  const block = result.content[0];
  return block?.type === 'text' ? block.text : undefined;
};

test('native conversion preserves tool IDs, error results, permissions text and tool choice', () => {
  const result = toResponses(
    {
      ...body,
      tool_choice: { type: 'tool', name: 'Read', disable_parallel_tool_use: true },
      messages: [
        ...messages,
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'fixture' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              is_error: true,
              content: 'Permission denied',
            },
          ],
        },
      ],
    },
    'gpt-6-astra',
  );
  assert.equal(result.instructions, 'Follow the task');
  assert.equal(callId(result.input[1]), 'call_1');
  assert.deepEqual(result.input[2], {
    type: 'function_call_output',
    call_id: 'call_1',
    output: 'Tool error:\nPermission denied',
  });
  assert.deepEqual(result.tool_choice, { type: 'function', name: 'Read' });
  assert.equal(result.parallel_tool_calls, false);
  assert.equal(result.store, false);
  assert.equal(result.tools[0].strict, false);
  assert.throws(
    () =>
      toResponses(
        { ...body, messages: [{ role: 'user', content: [{ type: 'document' }] }] },
        'gpt',
      ),
    /Unsupported/,
  );
  assert.throws(
    () => toResponses({ ...body, tools: [{ type: 'web_search_20250305' }] }, 'gpt'),
    /Unsupported/,
  );
});

test('Responses stream preserves native tool arguments, usage and stop reason', async () => {
  const sent: { type: StreamEventName; value: StreamEventBody }[] = [];
  const args = '{"file_path":"fixture"}';
  const item: SseEvent = {
    type: 'function_call',
    call_id: 'call_1',
    name: 'Read',
    arguments: args,
  };
  const result = await fromResponses(
    stream(
      events(item, [
        { type: 'response.function_call_arguments.delta', delta: '{"file_path":' },
        { type: 'response.function_call_arguments.delta', delta: '"fixture"}' },
      ]),
    ),
    model,
    (type, value) => {
      sent.push({ type, value });
    },
  );
  assert.equal(result.stop_reason, 'tool_use');
  const call = result.content[0];
  assert(call.type === 'tool_use');
  assert.deepEqual(call.input, { file_path: 'fixture' });
  assert.equal(result.usage.input_tokens, 60);
  assert.equal(result.usage.cache_read_input_tokens, 40);
  assert.equal(sent.at(-1)?.type, 'message_stop');
  const partial = sent.flatMap(({ value }) =>
    'index' in value && 'delta' in value && value.delta.type === 'input_json_delta'
      ? [value.delta.partial_json]
      : [],
  );
  assert.equal(partial.join(''), args);
});

test('images retain their order and tool-result association across provider switches', () => {
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'cGl4ZWxz' },
  };
  const remote = { type: 'image', source: { type: 'url', url: 'https://example.com/fixture.png' } };
  const request: MessagesRequest = {
    ...body,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Compare' },
          image,
          { type: 'text', text: 'with the tool image' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_image', name: 'Read', input: { file_path: 'fixture.png' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_image',
            is_error: true,
            content: [
              { type: 'text', text: 'Partial screenshot' },
              remote,
              { type: 'text', text: 'Capture timed out' },
            ],
          },
        ],
      },
    ],
  };
  const snapshot = structuredClone(request);
  const converted = toResponses(request, 'gpt');
  assert.deepEqual(
    converted.input.slice(0, 3).map((item) => contentOf(item)[0]?.type),
    ['input_text', 'input_image', 'input_text'],
  );
  assert.deepEqual(contentOf(converted.input[1]), [
    { type: 'input_image', image_url: 'data:image/png;base64,cGl4ZWxz', detail: 'auto' },
  ]);
  assert.equal(callId(converted.input[3]), 'call_image');
  assert.deepEqual(converted.input[4], {
    type: 'function_call_output',
    call_id: 'call_image',
    output: [
      { type: 'input_text', text: 'Tool error:\n' },
      { type: 'input_text', text: 'Partial screenshot' },
      { type: 'input_image', image_url: remote.source.url, detail: 'auto' },
      { type: 'input_text', text: 'Capture timed out' },
    ],
  });
  assert.equal(forAnthropic(request), request);
  assert.deepEqual(request, snapshot, 'Conversion must not rewrite the stored transcript');
});

test('structured output keeps the schema intact for modern and legacy Anthropic formats', () => {
  const schema = {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  };
  const format = { type: 'json_schema', schema };
  const modern = toResponses(
    { ...body, output_config: { format, effort: 'high' }, output_format: { type: 'ignored' } },
    'gpt',
  );
  const legacy = toResponses({ ...body, output_format: format }, 'gpt');
  assert.deepEqual(modern.text, {
    format: { type: 'json_schema', name: 'claude_output', schema, strict: true },
  });
  assert.deepEqual(legacy.text, modern.text);
  assert.equal(modern.reasoning.effort, 'high');
  assert.equal(
    modern.text?.format.schema,
    schema,
    'Do not rewrite optional fields or schema constraints',
  );
  assert.equal(toResponses(body, 'gpt').text, undefined);
});

test('malformed images and output formats fail before any provider call', async (t) => {
  const call = await gateway(t, () => assert.fail('Unexpected provider request'));
  for (const source of [
    undefined,
    { type: 'file', file_id: 'private-file' },
    { type: 'base64', media_type: 'image/svg+xml', data: 'cGl4ZWxz' },
    { type: 'base64', media_type: 'image/png', data: 'invalid?!' },
    { type: 'base64', media_type: 'image/png', data: '' },
    { type: 'url', url: 'file:///etc/passwd' },
    { type: 'url', url: 'https://user:secret@example.com/image' },
  ]) {
    const content = [{ type: 'image', source }];
    for (const value of [content, [{ type: 'tool_result', tool_use_id: 'call_image', content }]]) {
      assert.equal(
        (await call({ ...body, messages: [{ role: 'user', content: value }] })).status,
        400,
      );
    }
  }
  for (const format of [
    false,
    { type: 'text' },
    { type: 'json_schema' },
    { type: 'json_schema', schema: [] },
  ]) {
    assert.equal((await call({ ...body, output_config: { format } })).status, 400);
  }
  assert.equal((await call({ ...body, stop_sequences: [''] })).status, 400);
});

test('encrypted reasoning survives a tool round trip without a shared conversation cache', async () => {
  const item = {
    type: 'reasoning',
    id: 'rs_1',
    summary: [{ type: 'summary_text', text: 'Checking' }],
    encrypted_content: 'opaque-ciphertext',
  };
  const result = await fromResponses(
    stream(events(item, [{ type: 'response.reasoning_summary_text.delta', delta: 'Checking' }])),
    model,
  );
  const converted = toResponses(
    { ...body, messages: [{ role: 'assistant', content: result.content }] },
    'gpt',
  );
  assert.deepEqual(converted.input[0], item);
  assert.deepEqual(
    toResponses(
      {
        ...body,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Private Claude state', signature: 'foreign' },
              { type: 'redacted_thinking', data: 'private' },
            ],
          },
        ],
      },
      'gpt',
    ).input,
    [],
  );
});

test('switching back to Claude removes OpenAI reasoning while preserving messages and tool history', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' };
  const reply = await fromResponses(stream(events(reasoning)), model);
  const claudeThought = {
    type: 'thinking',
    thinking: 'Claude state',
    signature: 'claude-signature',
  };
  const tool = { type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'fixture' } };
  const stored: RequestMessage[] = [
    { role: 'assistant', content: [claudeThought, { type: 'text', text: 'Original answer' }] },
    { role: 'assistant', content: reply.content },
    { role: 'assistant', content: [...reply.content, tool] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'fixture nonce' }],
    },
  ];
  const mixed = { ...body, messages: stored };
  const cleaned = forAnthropic(mixed).messages ?? [];
  assert.equal(cleaned.length, 3);
  assert.deepEqual(cleaned[0], stored[0]);
  assert.deepEqual(cleaned[1].content, [tool]);
  assert.deepEqual(cleaned[2], stored[3]);
  assert(!JSON.stringify(cleaned).includes('multi-openai:'));
  const untouched = stored[2].content;
  assert.equal(
    Array.isArray(untouched) && untouched.length,
    2,
    'Stored transcript must not be mutated',
  );
  assert.equal(forAnthropic(body), body, 'Unmixed Claude requests retain byte-exact passthrough');
});

test('fragmented SSE and truncated or failed responses never become successful completions', async () => {
  const bytes = new TextEncoder().encode(sse([{ type: 'example', text: 'héllo' }]));
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) {
        controller.enqueue(Uint8Array.of(byte));
      }
      controller.close();
    },
  });
  const parsed: unknown[] = [];
  for await (const event of readSse(input)) {
    parsed.push(event);
  }
  assert.deepEqual(parsed, [{ type: 'example', text: 'héllo' }]);
  const refusal = await fromResponses(
    stream(
      events({ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot do that' }] }, [
        { type: 'response.refusal.delta', delta: 'Cannot do that' },
      ]),
    ),
    model,
  );
  assert.equal(textOf(refusal), 'Cannot do that');
  await assert.rejects(fromResponses(stream(textEvents.slice(0, -1)), model), /before completion/);
  await assert.rejects(
    fromResponses(
      stream([{ type: 'response.failed', response: { error: { message: 'Denied' } } }]),
      model,
    ),
    /Denied/,
  );
});

async function gateway(
  t: TestContext,
  fetchImpl: GatewayFetch,
  options: { timeoutMs?: number; agentCatalog?: AgentCatalog; receipts?: ReceiptLedger } = {},
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-gateway-test-'));
  const authFile = path.join(cwd, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'openai-secret', account_id: 'account-test' },
    }),
  );
  const server = createNativeGateway({
    token: 'local-test-secret',
    authFile,
    fetchImpl,
    ...options,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTemporary(cwd);
  });
  const address = server.address();
  assert(address !== null && typeof address === 'object', 'Gateway port');
  return (
    payload: unknown,
    headers: Record<string, string> = {},
    endpoint = '/v1/messages?beta=true',
  ) =>
    fetch(`http://127.0.0.1:${address.port}${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-multi-gateway-token': 'local-test-secret',
        ...headers,
      },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
}

test('gateway receipts aggregate provider responses until the owning worker finishes', async (t) => {
  const lines: string[] = [];
  const receipts = new ReceiptLedger({
    writer: async (line) => {
      lines.push(line);
    },
  });
  let responses = 0;
  const call = await gateway(
    t,
    async () => new Response(sse(textEvents).replaceAll('resp_test', `resp_${++responses}`)),
    { receipts },
  );
  const headers = { 'x-claude-code-session-id': 's', 'x-claude-code-agent-id': 'a' };
  for (let step = 0; step < 2; step++) {
    assert.equal((await call({ ...body, output_config: { effort: 'high' } }, headers)).status, 200);
  }
  assert.equal(lines.length, 0);
  const response = await call(
    { sessionId: 's', agentId: 'a', turnId: 't', outcome: 'answer' },
    {},
    '/multi/mod/usage/complete',
  );
  assert.equal(response.status, 200);
  await receipts.drain();
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.requests, 2);
  assert.equal(receipt.usage.output_tokens, 30);
  assert.equal(receipt.entries[0].model, 'gpt-6-astra');
  assert.equal(receipt.entries[0].effort, 'high');
  assert.equal(receipt.entries[0].source, 'provider');
  assert.equal(receipts.snapshot('other').requests, 0);
  assert.equal(
    (
      await call(
        { sessionId: 's', agentId: 'a', turnId: 't', outcome: 'invalid' },
        {},
        '/multi/mod/usage/complete',
      )
    ).status,
    400,
  );
});

test('Claude subscription requests retain their raw body, OAuth and beta headers', async (t) => {
  const raw = '{ "model": "claude-opus-4-6", "messages": [] }';
  const call = await gateway(t, async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages?beta=true');
    assert.equal(String(options.body), raw);
    assert.equal(options.headers.authorization, 'Bearer claude-secret');
    assert.equal(options.headers['anthropic-beta'], 'oauth-test,tools-test');
    assert.equal(options.headers['x-multi-gateway-token'], undefined);
    assert(!JSON.stringify(options.headers).includes('openai-secret'));
    return new Response('original stream', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const response = await call(raw, {
    authorization: 'Bearer claude-secret',
    'anthropic-beta': 'oauth-test,tools-test',
  });
  assert.equal(await response.text(), 'original stream');
});

test('Claude on-demand tools and tool references pass through the gateway unchanged', async (t) => {
  const request = {
    model: 'claude-sonnet-5',
    tools: [
      { name: 'ToolSearch', input_schema: { type: 'object' } },
      { name: 'example_lookup', input_schema: { type: 'object' }, defer_loading: true },
    ],
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'search', name: 'ToolSearch', input: { query: 'example' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'search',
            content: [{ type: 'tool_reference', tool_name: 'example_lookup' }],
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(request);
  let forwarded = false;
  const call = await gateway(t, async (_url, options) => {
    assert.equal(String(options.body), raw);
    forwarded = true;
    return Response.json({ content: [{ type: 'text', text: 'ok' }] });
  });
  const response = await call(raw);
  assert.equal(response.status, 200);
  assert.equal(forwarded, true);
});

test('OpenAI cache keys survive history changes and restart, isolating sessions, workers and models', async (t) => {
  const keys: string[] = [];
  const upstream: GatewayFetch = async (_url, options) => {
    const request = JSON.parse(String(options.body));
    assert.match(request.prompt_cache_key, /^[a-f0-9]{64}$/);
    keys.push(request.prompt_cache_key);
    return new Response(sse(textEvents));
  };
  const call = await gateway(t, upstream);
  const restarted = await gateway(t, upstream);
  const payload = { ...body, metadata: { user_id: JSON.stringify({ session_id: 'session-a' }) } };
  await (await call(payload)).text();
  await (
    await call({ ...payload, messages: [{ role: 'user', content: 'Different history' }] })
  ).text();
  await (await restarted(payload)).text();
  await (
    await call({ ...body, metadata: { user_id: JSON.stringify({ session_id: 'session-b' }) } })
  ).text();
  await (await call(payload, { 'x-claude-code-agent-id': 'worker-a' })).text();
  await (await call({ ...payload, model: 'multi/openai/gpt-6-luna' })).text();
  await (await call(body)).text();
  await (await call(body)).text();
  await (await restarted(body)).text();
  assert.equal(keys.length, 9);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[0], keys[2]);
  assert.equal(new Set([keys[0], ...keys.slice(3, 7), keys[8]]).size, 6);
  assert.equal(keys[6], keys[7]);
});

test('OpenAI main and worker requests adapt instructions without losing runtime policy or changing translation', async (t) => {
  const runtime =
    'Runtime policy: Plan is read-only. Never edit secrets. Custom worker scope. Use agents when appropriate; use headings for reports.';
  const payload = { ...body, system: runtime };
  const seen: ResponsesRequest[] = [];
  const call = await gateway(t, async (_url, options) => {
    seen.push(JSON.parse(String(options.body)));
    return new Response(sse(textEvents));
  });
  for (const name of ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-6-luna']) {
    await (await call({ ...payload, model: `multi/openai/${name}` })).text();
  }
  await (await call(payload, { 'x-claude-code-agent-id': 'worker-a' })).text();
  assert.equal(seen.length, 5);
  for (const request of seen) {
    assert.equal(request.instructions, openaiInstructions(runtime));
    assert(request.instructions.startsWith(runtime));
    assert.doesNotMatch(
      request.instructions,
      /Do not call EnterPlanMode unless|Use Agent only when|The user gets very frustrated|Avoid section headings|Do not write tests for reversible/,
    );
    const translated = toResponses(payload, request.model);
    assert.deepEqual(request.input, translated.input);
    assert.deepEqual(request.tools, translated.tools);
    assert.equal(translated.instructions, runtime, 'Shared translation used by Zen is unchanged');
  }
  const response = await call(payload, {}, '/v1/messages/count_tokens');
  assert.deepEqual(await response.json(), { input_tokens: estimateInputTokens(seen[0]) });
  assert.equal(seen.length, 5, 'Counting must not call the provider');
});

test('Claude prompts remain unchanged after OpenAI main and worker requests, including token counts', async (t) => {
  const runtime = 'Claude runtime policy: use agents when appropriate.';
  const metadata = { user_id: JSON.stringify({ session_id: 'prompt-isolation' }) };
  let openaiCalls = 0;
  let claudeCalls = 0;
  const call = await gateway(t, async (url, options) => {
    const request = JSON.parse(String(options.body));
    if (url.startsWith('https://api.anthropic.com/')) {
      claudeCalls++;
      assert.deepEqual(request.system, body.system);
      assert.equal(request.instructions, undefined);
      assert(!String(options.body).includes('# OpenAI provider instructions'));
      return Response.json({ content: [], input_tokens: 10 });
    }
    openaiCalls++;
    assert.equal(request.instructions, openaiInstructions(runtime));
    return new Response(sse(textEvents));
  });
  const scopes: Record<string, string>[] = [{}, { 'x-claude-code-agent-id': 'worker-a' }];
  for (const headers of scopes) {
    await (await call({ ...body, metadata, system: runtime }, headers)).text();
    for (const claudeModel of ['claude-opus-4-6', 'claude-sonnet-5']) {
      const payload = { ...body, metadata, model: claudeModel };
      for (const endpoint of ['/v1/messages', '/v1/messages/count_tokens']) {
        const response = await call(payload, headers, endpoint);
        assert.equal(response.status, 200);
        await response.text();
      }
    }
  }
  assert.equal(openaiCalls, 2);
  assert.equal(claudeCalls, 8);
});

test('catalog filtering reaches Claude and OpenAI without changing user text or native registration', async (t) => {
  const row = '- hidden: Hidden worker (Tools: Read)';
  const text = `<system-reminder>\nAvailable agent types for the Agent tool:\n${row}\n- custom: Keep this (Tools: Read)\n</system-reminder>`;
  const seen: string[] = [];
  const call = await gateway(
    t,
    async (url, options) => {
      seen.push(String(options.body));
      return url.includes('anthropic')
        ? Response.json({ content: [] })
        : new Response(sse(textEvents));
    },
    {
      agentCatalog: new AgentCatalog(
        { hidden: { model, description: 'Hidden worker', tools: ['Read'] } },
        [],
      ),
    },
  );
  for (const choice of [model, 'claude-sonnet-5']) {
    await (
      await call({
        model: choice,
        messages: [
          { role: 'user', content: text },
          { role: 'user', content: row },
        ],
      })
    ).text();
  }
  assert.equal(seen.length, 2);
  for (const sent of seen) {
    assert.equal(sent.split('Hidden worker').length - 1, 1);
    assert(sent.includes('Keep this'));
  }
});

test('external route isolates provider credentials and handles simultaneous worker identities', async (t) => {
  const ids: string[] = [];
  const models: string[] = [];
  const call = await gateway(t, async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(options.headers.authorization, 'Bearer openai-secret');
    assert(!JSON.stringify(options.headers).includes('claude-secret'));
    assert(!JSON.stringify(options.headers).includes('local-test-secret'));
    ids.push(options.headers.session_id);
    const request: ResponsesRequest = JSON.parse(String(options.body));
    models.push(request.model);
    return new Response(sse(textEvents), { headers: { 'content-type': 'text/event-stream' } });
  });
  const slugs = ['gpt-6-astra', 'gpt-6-luna'];
  const responses = await Promise.all(
    slugs.map((slug, i) =>
      call(
        { ...body, model: `multi/openai/${slug}` },
        { authorization: 'Bearer claude-secret', 'x-claude-code-agent-id': ['a', 'b'][i] },
      ),
    ),
  );
  for (const [i, response] of responses.entries()) {
    const result = await readMessage(response);
    assert.equal(result.model, `multi/openai/${slugs[i]}`);
    assert.equal(textOf(result), 'Done');
    assert.equal(result.stop_reason, 'end_turn');
  }
  assert.deepEqual(ids.sort(), ['a', 'b']);
  assert.deepEqual(models.sort(), [...slugs].sort());
});

test('browser, unauthenticated and unregistered external requests never reach a provider', async (t) => {
  const call = await gateway(t, () => assert.fail('Unexpected provider request'));
  assert.equal((await call(body, { origin: 'https://example.com' })).status, 403);
  assert.equal((await call(body, { 'x-multi-gateway-token': 'wrong' })).status, 403);
  for (const unknownModel of ['multi/openai/unknown', 'multi/cursor/gpt-6-luna']) {
    assert.equal(
      (await call({ ...body, model: unknownModel }, { 'x-claude-code-agent-id': 'a' })).status,
      400,
    );
  }
  assert.equal(
    (await call({ ...body, output_config: { effort: 'ultra' } }, { 'x-claude-code-agent-id': 'a' }))
      .status,
    400,
  );
});

test('main GPT requests use their Claude session identity and isolated OpenAI authentication', async (t) => {
  const call = await gateway(t, async (_url, options) => {
    assert.equal(options.headers.session_id, 'main-session');
    assert.equal(options.headers.authorization, 'Bearer openai-secret');
    assert(!JSON.stringify(options.headers).includes('claude-secret'));
    return new Response(sse(textEvents));
  });
  const response = await call(body, {
    authorization: 'Bearer claude-secret',
    'x-claude-code-session-id': 'main-session',
  });
  assert.equal(response.status, 200);
  assert.equal(textOf(await readMessage(response)), 'Done');
});

test('all registered model and reasoning choices reach OpenAI without substitution', async (t) => {
  const call = await gateway(t, async (_url, options) => {
    const [slug, effort] = options.headers.session_id.split(':');
    const request: ResponsesRequest = JSON.parse(String(options.body));
    assert.equal(request.model, slug);
    assert.equal(request.reasoning.effort, effort);
    return new Response(sse(textEvents));
  });
  for (const [name, slug] of [
    ['openai-native', 'gpt-6-astra'],
    ['openai-sol', 'gpt-6-sol'],
    ['openai-terra', 'gpt-5.6-terra'],
    ['openai-luna', 'gpt-6-luna'],
  ]) {
    assert.deepEqual(OPENAI_WORKERS[name], { model: slug, effort: 'medium' });
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.deepEqual(OPENAI_WORKERS[`${name}-${effort}`], { model: slug, effort });
      const response = await call(
        { ...body, model: `multi/openai/${slug}`, output_config: { effort } },
        { 'x-claude-code-agent-id': `${slug}:${effort}` },
      );
      assert.equal(response.status, 200);
      const result = await readMessage(response);
      assert.equal(result.model, `multi/openai/${slug}`);
    }
  }
});

test('a dropped downstream connection aborts external inference', async (t) => {
  const started = Promise.withResolvers<AbortSignal>();
  const call = await gateway(t, async (_url, options) => {
    started.resolve(options.signal);
    return new Response(
      new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => controller.error(new Error('cancelled')), {
            once: true,
          });
        },
      }),
    );
  });
  const pending = call({ ...body, stream: true }, { 'x-claude-code-agent-id': 'a' });
  const upstreamSignal = await started.promise;
  const response = await pending;
  await response.body?.cancel();
  await new Promise<void>((resolve) =>
    upstreamSignal.addEventListener('abort', () => resolve(), { once: true }),
  );
  assert(upstreamSignal.aborted);
});

test('an auth.json without usable ChatGPT credentials fails before any upstream call', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-auth-test-'));
  t.after(() => removeTemporary(cwd));
  const authFile = path.join(cwd, 'auth.json');
  for (const tokens of [
    { access_token: '', account_id: 'account-test' },
    { access_token: 'openai-secret', account_id: '' },
    {},
  ]) {
    await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens }));
    await assert.rejects(readCodexAuth(authFile), /require a Codex ChatGPT login/);
  }
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'openai-secret', account_id: 'account-test' },
    }),
  );
  assert.deepEqual(await readCodexAuth(authFile), {
    authorization: 'Bearer openai-secret',
    'chatgpt-account-id': 'account-test',
  });
});

test('malformed provider stream events fail by name; unknown event types are ignored', async () => {
  const created = textEvents[0];
  assert(created);
  await assert.rejects(
    fromResponses(
      stream([created, { type: 'response.output_text.delta', output_index: 0 }]),
      model,
    ),
    /malformed response\.output_text\.delta/,
  );
  await assert.rejects(
    fromResponses(
      stream([
        created,
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', name: 42 },
        },
      ]),
      model,
    ),
    /malformed response\.output_item\.added/,
  );
  await assert.rejects(
    fromResponses(stream([{ type: 'response.created', response: {} }]), model),
    /malformed response\.created/,
  );
  const result = await fromResponses(
    stream([{ type: 'response.in_progress', sequence_number: 1 }, ...textEvents]),
    model,
  );
  const text = result.content[0];
  assert(text.type === 'text');
  assert.equal(text.text, 'Done');
});

test('long MCP names round-trip across tool definitions, calls, choices and fresh requests', async () => {
  const name = `mcp__provider_${'long_name_'.repeat(20)}`;
  const collision = toolName(name);
  const request: MessagesRequest = {
    messages,
    tools: [
      { name, input_schema: {} },
      { name: collision, input_schema: {} },
    ],
    tool_choice: { type: 'tool', name },
  };
  const converted = toResponses(request, 'gpt');
  assert(converted.tools.every((t) => t.name.length <= 64));
  assert.notEqual(converted.tools[0].name, converted.tools[1].name);
  assert.deepEqual(converted.tool_choice, { type: 'function', name: converted.tools[0].name });
  const reply = await fromResponses(
    stream(
      events({
        type: 'function_call',
        call_id: 'call_1',
        name: converted.tools[0].name,
        arguments: '{}',
      }),
    ),
    model,
    undefined,
    { toolNames: originalToolNames(request) },
  );
  assert.deepEqual(reply.content[0], { type: 'tool_use', id: 'call_1', name, input: {} });
  const resumed = toResponses(
    {
      ...request,
      messages: [
        { role: 'assistant', content: reply.content },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }],
        },
      ],
    },
    'gpt',
  );
  assert.equal((resumed.input[0] as { name: string }).name, converted.tools[0].name);
  const longId = `toolu_${'x'.repeat(150)}`;
  const history = toResponses(
    {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: longId, name, input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: longId, content: 'ok' }] },
      ],
    },
    'gpt',
  );
  assert.equal(wireCallId(longId).length <= 64, true);
  assert.equal(callId(history.input[0]), wireCallId(longId));
  assert.equal(callId(history.input[1]), wireCallId(longId));
});

test('PDF, text documents and discovered tool references preserve tool-result association', () => {
  const pdf = {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: Buffer.from('%PDF-1.4\nfixture').toString('base64'),
    },
  };
  const doc = {
    type: 'document',
    title: 'Notes',
    source: { type: 'text', media_type: 'text/plain', data: 'hello' },
  };
  const converted = toResponses(
    {
      messages: [
        {
          role: 'user',
          content: [
            pdf,
            doc,
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: [pdf, { type: 'tool_reference', tool_name: 'Read' }],
            },
          ],
        },
      ],
    },
    'gpt',
  );
  assert.equal(contentOf(converted.input[0])[0].type, 'input_file');
  assert.deepEqual(contentOf(converted.input[1]), [
    { type: 'input_text', text: 'Document: Notes\nhello' },
  ]);
  assert.deepEqual(converted.input[2], {
    type: 'function_call_output',
    call_id: 'call_1',
    output: [
      {
        type: 'input_file',
        filename: 'document.pdf',
        file_data: `data:application/pdf;base64,${pdf.source.data}`,
      },
      { type: 'input_text', text: 'Available tool: Read' },
    ],
  });
});

test('parallel calls with delayed names emit complete, sequential Claude blocks', async () => {
  const emitted: { type: string; value: StreamEventBody }[] = [];
  const result = await fromResponses(
    stream([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call' } },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', call_id: 'b', name: 'Read', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"file_path":"first"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'function_call',
          call_id: 'b',
          name: 'Read',
          arguments: '{"file_path":"second"}',
        },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'a',
          name: 'Read',
          arguments: '{"file_path":"first"}',
        },
      },
      { type: 'response.completed', response: { id: 'r' } },
    ]),
    model,
    (type, value) => {
      emitted.push({ type, value });
    },
  );
  assert.deepEqual(
    result.content.map((b) => b.type === 'tool_use' && b.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    emitted.map((e) => e.type),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  );
});

test('stop sequences crossing deltas stop before exposing text or later tools', async () => {
  const sent: string[] = [];
  const result = await fromResponses(
    stream(
      events({ type: 'message', content: [{ type: 'output_text', text: 'hello STOP secret' }] }, [
        { type: 'response.output_text.delta', delta: 'hello ST' },
        { type: 'response.output_text.delta', delta: 'OP secret' },
      ]),
    ),
    model,
    (_type, value) => {
      if ('delta' in value && 'text' in value.delta) {
        sent.push(value.delta.text);
      }
    },
    { stopSequences: ['STOP'] },
  );
  assert.equal(sent.join(''), 'hello ');
  assert.equal(textOf(result), 'hello ');
  assert.equal(result.stop_reason, 'stop_sequence');
  assert.equal(result.stop_sequence, 'STOP');
  const ordinary = await fromResponses(
    stream(
      events({ type: 'message', content: [{ type: 'output_text', text: 'hello ST' }] }, [
        { type: 'response.output_text.delta', delta: 'hello ST' },
      ]),
    ),
    model,
    undefined,
    { stopSequences: ['STOP'] },
  );
  assert.equal(textOf(ordinary), 'hello ST', 'Flush a partial stop prefix at normal completion');
});

test('malformed nested output never becomes a successful answer or reusable reasoning state', async () => {
  for (const item of [
    { type: 'message', content: [{ type: 'output_text', text: { invalid: true } }] },
    { type: 'reasoning', encrypted_content: 123 },
    {
      type: 'reasoning',
      encrypted_content: 'cipher',
      summary: [{ type: 'summary_text', text: false }],
    },
    { type: 'function_call', call_id: 'c', name: 'Read', arguments: '[]' },
  ]) {
    await assert.rejects(fromResponses(stream(events(item)), model));
  }
  for (const usage of [
    { input_tokens: -1 },
    { output_tokens: 'oops' },
    { input_tokens_details: { cached_tokens: null } },
  ]) {
    await assert.rejects(
      fromResponses(
        stream([
          ...textEvents.slice(0, -1),
          { type: 'response.completed', response: { id: 'r', usage } },
        ]),
        model,
      ),
      /malformed/,
    );
  }
});

test('count_tokens is local, includes schemas, and labels its estimate', async (t) => {
  const call = await gateway(t, () => assert.fail('Token counting must not call either provider'));
  const response = await call(body, {}, '/v1/messages/count_tokens');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-multi-token-count'), 'estimate');
  const count = (await response.json()) as { input_tokens: number };
  assert(Number.isSafeInteger(count.input_tokens) && count.input_tokens > 0);
  const plain = estimateInputTokens(toResponses({ messages }, 'gpt'));
  const schema = estimateInputTokens(
    toResponses(
      { ...body, tools: [{ name: 'Read', input_schema: { description: 'extra '.repeat(1000) } }] },
      'gpt',
    ),
  );
  assert(schema > plain + 500);
});

test('HTTP failures retain status and retry-after without returning private upstream bodies', async (t) => {
  for (const status of [400, 401, 403, 404, 429, 503]) {
    const call = await gateway(
      t,
      async () =>
        new Response('secret provider diagnostic', { status, headers: { 'retry-after': '17' } }),
    );
    const response = await call(body);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('retry-after'), '17');
    assert(!(await response.text()).includes('secret provider diagnostic'));
  }
});

test('invalid request shapes fail locally and legacy thinking budgets respect explicit effort', async (t) => {
  const call = await gateway(t, () => assert.fail('Invalid requests must not reach a provider'));
  for (const invalid of [
    null,
    [],
    { model: 12 },
    { ...body, messages: [null] },
    { ...body, messages: [{ role: 'user', content: [null] }] },
    { ...body, tools: [null] },
    { ...body, tools: {} },
    { ...body, stream: 'yes' },
    { ...body, tool_choice: { type: 'tool', name: 'missing' } },
  ]) {
    assert.equal((await call(invalid)).status, 400);
  }
  assert.equal(
    toResponses({ ...body, thinking: { type: 'enabled', budget_tokens: 16000 } }, 'gpt').reasoning
      .effort,
    'high',
  );
  assert.equal(
    toResponses(
      {
        ...body,
        thinking: { type: 'enabled', budget_tokens: 16000 },
        output_config: { effort: 'max' },
      },
      'gpt',
    ).reasoning.effort,
    'max',
  );
});

test('multiple text parts, unknown events, and oversized SSE frames have explicit outcomes', async () => {
  const result = await fromResponses(
    stream(
      events(
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'first' },
            { type: 'output_text', text: 'second' },
          ],
        },
        [
          { type: 'response.output_text.delta', delta: 'first' },
          { type: 'response.output_text.delta', delta: 'second' },
        ],
      ),
    ),
    model,
  );
  assert.equal(textOf(result), 'firstsecond');
  async function* oversized() {
    yield new TextEncoder().encode(`data: ${'x'.repeat(8 * 1024 * 1024)}`);
  }
  await assert.rejects(async () => {
    for await (const _ of readSse(oversized())) {
    }
  }, /exceeds 8 MiB/);
  await assert.rejects(
    fromResponses(
      stream(events({ type: 'function_call', call_id: 'c', name: 'notDeclared', arguments: '{}' })),
      model,
      undefined,
      { toolNames: new Map([['Read', 'Read']]) },
    ),
    /undeclared tool/,
  );
});

test('oversized uploads receive HTTP 413 while the client is still streaming', async (t) => {
  const server = createNativeGateway({ token: 'test', authFile: 'unused' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const init: RequestInit = {
    method: 'POST',
    headers: { 'x-multi-gateway-token': 'test' },
    duplex: 'half',
    signal: AbortSignal.timeout(5000),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      },
    }),
  };
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, init);
  assert.equal(response.status, 413);
  assert.equal(await response.text(), 'Request too large');
});

test('OpenAI has no implicit request deadline while explicit limits and Claude passthrough remain bounded', async (t) => {
  const durations: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    durations.push(ms);
    return new AbortController().signal;
  });
  const upstream: GatewayFetch = async (url) =>
    url.includes('api.anthropic.com')
      ? new Response('{}', { headers: { 'content-type': 'application/json' } })
      : new Response(sse(textEvents));
  const ordinary = await gateway(t, upstream);
  assert.equal((await ordinary(body)).status, 200);
  assert.deepEqual(durations, [], 'Astra must not inherit an absolute three-minute timer');
  assert.equal((await ordinary({ model: 'claude-sonnet-5', messages })).status, 200);
  assert.deepEqual(durations, [180000]);
  const bounded = await gateway(t, upstream, { timeoutMs: 25 });
  assert.equal((await bounded(body)).status, 200);
  assert.deepEqual(durations, [180000, 25]);
});

test('an explicit OpenAI timeout aborts upstream inference', async (t) => {
  let aborted = false;
  const call = await gateway(
    t,
    async (_url, options) => {
      await new Promise<void>((_resolve, reject) => {
        const stop = () => {
          aborted = true;
          reject(options.signal.reason);
        };
        options.signal.addEventListener('abort', stop, { once: true });
        if (options.signal.aborted) {
          stop();
        }
      });
      return new Response(sse(textEvents));
    },
    { timeoutMs: 15 },
  );
  const response = await call(body);
  assert.equal(response.status, 502);
  assert.equal(aborted, true);
  assert.match(await response.text(), /timeout|timed out/i);
});

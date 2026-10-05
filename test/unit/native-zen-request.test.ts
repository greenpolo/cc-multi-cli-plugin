import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessagesRequest } from '../../plugins/multi-core/src/gateway/messages.ts';
import type { ResponsesInputItem } from '../../plugins/multi-core/src/gateway/responses.ts';
import { fromResponses } from '../../plugins/multi-core/src/gateway/responses.ts';
import { toChat } from '../../plugins/multi-zen/src/chat.ts';
import { zenRequest } from '../../plugins/multi-zen/src/request.ts';

const responsesModel = 'multi/zen/gpt-5.6-luna';
const chatModel = 'multi/zen/kimi-k3';
const textMessage = { role: 'user' as const, content: 'hello' };

function request(model = responsesModel): MessagesRequest {
  return { model, max_tokens: 100, system: 'stable system', messages: [textMessage] };
}

function imageMessage() {
  return {
    role: 'user' as const,
    content: [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
      },
    ],
  };
}

function pdfMessage() {
  return {
    role: 'user' as const,
    content: [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from('%PDF-1.4 fixture').toString('base64'),
        },
      },
    ],
  };
}

async function* sse(events: unknown[]) {
  for (const event of events) {
    yield Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function responsesBody(result: ReturnType<typeof zenRequest>) {
  if (result.endpoint !== 'responses' || !('input' in result.body)) {
    throw new Error('Expected a Zen Responses request');
  }
  return result.body;
}

function isReasoning(
  item: ResponsesInputItem,
): item is Extract<ResponsesInputItem, { type: 'reasoning' }> {
  return 'type' in item && item.type === 'reasoning';
}

function reasoningResponse() {
  return [
    { type: 'response.created', response: { id: 'response-1' } },
    {
      type: 'response.completed',
      response: {
        id: 'response-1',
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            id: 'reasoning-1',
            encrypted_content: 'opaque-state',
            summary: [{ type: 'summary_text', text: 'Compaction summary' }],
          },
        ],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
          output_tokens: 8,
        },
      },
    },
  ];
}

test('Zen request enforces capabilities, output limits, and protocol-specific effort', () => {
  const image = { ...request(chatModel), messages: [imageMessage()] };
  assert.doesNotThrow(() => zenRequest(image, 'cache-key'));
  assert.throws(
    () => zenRequest({ ...image, model: 'multi/zen/glm-5.2' }, 'cache-key'),
    /does not support images/,
  );
  assert.throws(
    () =>
      zenRequest({ ...request('multi/zen/minimax-m2.7'), messages: [pdfMessage()] }, 'cache-key'),
    /does not support PDF/,
  );
  assert.doesNotThrow(() => zenRequest({ ...request(), messages: [pdfMessage()] }, 'cache-key'));
  assert.throws(
    () => zenRequest({ ...request(), max_tokens: 128001 }, 'cache-key'),
    /between 1 and 128000/,
  );
  assert.equal(
    responsesBody(zenRequest({ ...request(), output_config: { effort: 'high' } }, 'cache-key'))
      .reasoning.effort,
    'high',
  );
  assert.throws(
    () => zenRequest({ ...request(), output_config: { effort: 'unsupported' } }, 'cache-key'),
    /Unsupported reasoning effort|does not support effort/,
  );

  const chat = zenRequest(
    { ...request(chatModel), output_config: { effort: 'high' } },
    'cache-key',
  );
  assert.equal(chat.endpoint, 'chat/completions');
  assert.equal('reasoning_effort' in chat.body, false);
  assert.equal('effort' in chat.body, false);
  assert.equal(toChat(request(chatModel), 'kimi-k3').messages[1]?.role, 'user');
});

test('Zen Responses prompt prefixes are stable when later turns append', () => {
  const first = zenRequest(request(), 'stable-cache-key');
  const extended = zenRequest(
    {
      ...request(),
      messages: [...(request().messages ?? []), { role: 'user', content: 'follow-up' }],
    },
    'stable-cache-key',
  );
  assert.equal(first.endpoint, 'responses');
  assert.equal(extended.endpoint, 'responses');
  const firstBody = responsesBody(first);
  const extendedBody = responsesBody(extended);
  assert.equal(firstBody.prompt_cache_key, extendedBody.prompt_cache_key);
  assert.deepEqual(
    extendedBody.input.slice(0, firstBody.input.length),
    firstBody.input,
    'existing prompt items remain byte-stable as new turns append',
  );
  assert.notDeepEqual(extendedBody.input, firstBody.input);
});

test('Zen reasoning signatures stay isolated across providers, models, and compaction summaries', async () => {
  const result = await fromResponses(sse(reasoningResponse()), 'gpt-5.6-luna', undefined, {
    signaturePrefix: 'multi-zen-responses:gpt-5.6-luna:',
  });
  const thinking = result.content.find((block) => block.type === 'thinking');
  assert(thinking?.type === 'thinking');
  assert(thinking.signature.startsWith('multi-zen-responses:gpt-5.6-luna:'));
  const continued: MessagesRequest = {
    ...request(),
    messages: [
      { role: 'assistant', content: [thinking] },
      { role: 'user', content: 'after compaction' },
    ],
  };
  const resumed = responsesBody(zenRequest(continued, 'cache-key'));
  const reasoning = resumed.input.find(isReasoning);
  assert(reasoning?.type === 'reasoning');
  assert.equal(reasoning.encrypted_content, 'opaque-state');
  assert.deepEqual(reasoning.summary, [{ type: 'summary_text', text: 'Compaction summary' }]);

  const switched = responsesBody(
    zenRequest({ ...continued, model: 'multi/zen/gpt-5.6-terra' }, 'cache-key'),
  );
  assert.equal(switched.input.some(isReasoning), false);
  const foreign = responsesBody(
    zenRequest(
      {
        ...continued,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '', signature: 'multi-openai:foreign' }],
          },
          { role: 'user', content: 'after provider switch' },
        ],
      },
      'cache-key',
    ),
  );
  assert.equal(foreign.input.some(isReasoning), false);
});

test('Zen Responses maps raw cache reads and writes into Claude usage fields', async () => {
  const result = await fromResponses(sse(reasoningResponse()), 'gpt-5.6-luna');
  assert.deepEqual(result.usage, {
    input_tokens: 50,
    output_tokens: 8,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 20,
  });
});

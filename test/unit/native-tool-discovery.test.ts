import assert from 'node:assert/strict';
import test from 'node:test';
import { toResponses } from '../../plugins/multi-openai/src/responses.ts';
import { toChat } from '../../plugins/multi-zen/src/chat.ts';

const body = {
  model: 'multi/openai/gpt-6-luna',
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: [{ type: 'tool_reference', tool_name: 'mcp__search' }],
        },
      ],
    },
  ],
  tools: [
    {
      name: 'mcp__search',
      description: 'Search the workspace',
      input_schema: { type: 'object' },
      defer_loading: true,
    },
    {
      name: 'Read',
      description: 'Read a file',
      input_schema: { type: 'object' },
    },
  ],
};

test('OpenAI omits deferred declarations and preserves loaded tools and references', () => {
  const initialRequest = toResponses(
    { ...body, messages: [{ role: 'user', content: 'find a file' }] },
    body.model,
  );
  assert.deepEqual(
    initialRequest.tools.map((tool) => tool.name),
    ['Read'],
  );
  const request = toResponses(body, body.model);
  assert.deepEqual(
    request.tools.map((tool) => tool.name),
    ['mcp__search', 'Read'],
  );
  const output = request.input.at(-1);
  assert(output && 'output' in output);
  assert.match(JSON.stringify(output.output), /Available tool: mcp__search/);
});

test('Zen omits deferred declarations and preserves loaded tools and references', () => {
  const initialRequest = toChat(
    { ...body, model: 'multi/zen/glm-5.2', messages: [{ role: 'user', content: 'find a file' }] },
    'multi/zen/glm-5.2',
  );
  assert.deepEqual(
    initialRequest.tools?.map((tool) => tool.function.name),
    ['Read'],
  );
  const request = toChat({ ...body, model: 'multi/zen/glm-5.2' }, 'multi/zen/glm-5.2');
  assert.deepEqual(
    request.tools?.map((tool) => tool.function.name),
    ['mcp__search', 'Read'],
  );
  assert.match(String(request.messages.at(-1)?.content), /Available tool: mcp__search/);
});

test('named tool choices retain the requested deferred declaration', () => {
  const initialBody = { ...body, messages: [{ role: 'user', content: 'find a file' }] };
  const request = toResponses(
    { ...initialBody, tool_choice: { type: 'tool', name: 'mcp__search' } },
    body.model,
  );
  assert.deepEqual(
    request.tools.map((tool) => tool.name),
    ['mcp__search', 'Read'],
  );
});

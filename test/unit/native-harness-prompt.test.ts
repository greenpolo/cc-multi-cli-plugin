import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareNativePrompt,
  validateNativeMessages,
} from '../../plugins/multi-core/src/gateway/harness-prompt.ts';
import type { MessagesRequest } from '../../plugins/multi-core/src/gateway/messages.ts';

const preamble = 'You are the Native coding agent displayed inside Claude Code.';
const base = { provider: 'Native', preamble };

const catalogue =
  '<system-reminder>The following deferred tools are now available via ToolSearch: Read, Edit</system-reminder>';
const instruction =
  '<system-reminder>Auto Mode is active; follow the rules in CLAUDE.md</system-reminder>';

test('the prompt is the preamble plus the conversation, with native tools left alone', () => {
  const body: MessagesRequest = {
    messages: [
      { role: 'user', content: 'fix the build' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private', signature: 'sig' },
          { type: 'text', text: 'on it' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] },
        ],
      },
    ],
  };
  const prepared = prepareNativePrompt(body, base);
  assert.equal(
    prepared.prompt,
    [
      preamble,
      [
        'user: fix the build',
        'assistant: on it[tool use Read] {"file":"a.ts"}',
        'user: [tool result toolu_1] ok',
      ].join('\n'),
    ].join('\n\n'),
  );
  assert.ok(prepared.inputTokens > 0);
});

test('catalogues are stripped only when the provider asks, and instructions always survive', () => {
  const body: MessagesRequest = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: `work${catalogue}${instruction}` }] },
    ],
  };
  const stripped = prepareNativePrompt(body, { ...base, stripCatalogues: true });
  assert.ok(!stripped.prompt.includes('deferred tools'));
  assert.ok(stripped.prompt.includes('Auto Mode is active'));

  const kept = prepareNativePrompt(body, base);
  assert.ok(kept.prompt.includes('deferred tools'));
  assert.ok(kept.prompt.includes('Auto Mode is active'));
  assert.ok(kept.inputTokens > stripped.inputTokens);
});

test('a turn left empty by catalogue removal is dropped only when the provider asks', () => {
  const body: MessagesRequest = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: catalogue }] },
      { role: 'user', content: 'the real question' },
    ],
  };
  const dropped = prepareNativePrompt(body, {
    ...base,
    stripCatalogues: true,
    dropEmptyTurns: true,
  });
  assert.equal(dropped.prompt, [preamble, 'user: the real question'].join('\n\n'));

  const kept = prepareNativePrompt(body, { ...base, stripCatalogues: true });
  assert.equal(kept.prompt, [preamble, 'user: \nuser: the real question'].join('\n\n'));

  assert.throws(
    () =>
      prepareNativePrompt(
        { messages: [{ role: 'user', content: [{ type: 'text', text: catalogue }] }] },
        { ...base, stripCatalogues: true, dropEmptyTurns: true },
      ),
    /Native requires a conversation with content/,
  );
});

test('unsupported content fails explicitly instead of being forwarded', () => {
  const cases: [MessagesRequest, RegExp][] = [
    [
      { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64' } }] }] },
      /Native CLI does not support content block image/,
    ],
    [
      {
        messages: [
          { role: 'user', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
        ],
      },
      /does not accept provider-owned reasoning content/,
    ],
    [
      { messages: [{ role: 'user', content: [{ type: 'tool_use', id: 'a', name: 'Read' }] }] },
      /requires assistant tool_use blocks/,
    ],
    [
      { messages: [{ role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'a' }] }] },
      /requires tool_result content/,
    ],
  ];
  for (const [body, expected] of cases) {
    assert.throws(() => prepareNativePrompt(body, base), expected);
  }
});

test('the request controls a native CLI cannot honour are refused', () => {
  const messages = [{ role: 'user', content: 'hello' }];
  assert.throws(() => validateNativeMessages({}, 'Native'), /Native requires a conversation/);
  assert.throws(
    () => validateNativeMessages({ messages: [{ role: 'tool', content: 'x' }] }, 'Native'),
    /requires valid conversation messages/,
  );
  assert.throws(
    () =>
      validateNativeMessages({ messages, output_config: { format: { type: 'json' } } }, 'Native'),
    /does not support strict Messages output schemas/,
  );
  assert.throws(
    () => validateNativeMessages({ messages, tool_choice: { type: 'any' } }, 'Native'),
    /only supports its native automatic tools/,
  );
  assert.throws(
    () => validateNativeMessages({ messages, thinking: { type: 'always' } }, 'Native'),
    /requires a valid thinking configuration/,
  );
  assert.throws(
    () => validateNativeMessages({ messages, stop_sequences: ['STOP'] }, 'Native'),
    /does not support Messages stop sequences/,
  );
  validateNativeMessages({ messages, thinking: { type: 'enabled', budget_tokens: 10 } }, 'Native');
});

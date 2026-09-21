import assert from 'node:assert/strict';
import test from 'node:test';
import type { HarnessEvent } from '../../plugins/multi-core/src/gateway/harness-exchange.ts';
import {
  HarnessResponse,
  type HarnessUsageFields,
  usageSource,
} from '../../plugins/multi-core/src/gateway/harness-response.ts';
import type { Emit } from '../../plugins/multi-core/src/gateway/messages.ts';
import type { ModDisplayEvent } from '../../plugins/multi-core/src/gateway/mod-bridge.ts';

function collector() {
  const events: HarnessEvent[] = [];
  const emit: Emit = (name, value) => events.push([name, structuredClone(value)]);
  return { events, emit };
}

const row: ModDisplayEvent = {
  sequence: 1,
  toolUseId: 'toolu_1',
  tool: 'NativeProgress',
  input: { description: 'read file', output: 'ok', isError: false, toolUseId: 'toolu_1' },
};

test('streamed text becomes one assistant block and its terminal events are held back', () => {
  const { events, emit } = collector();
  const response = new HarnessResponse('native-1', 11, emit);
  response.text('hello ');
  response.text('');
  response.text('world');
  assert.deepEqual(
    events.map(([name]) => name),
    ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta'],
  );

  const usage: HarnessUsageFields = {
    input: 20,
    output: 7,
    cacheRead: 3,
    cacheCreate: 2,
    reasoning: 5,
    total: 32,
  };
  const finished = response.finish(usage, 'native-1', 'high');
  assert.deepEqual(finished.content, [{ type: 'text', text: 'hello world' }]);
  assert.equal(finished.stop_reason, 'end_turn');
  assert.deepEqual(finished.usage, {
    input_tokens: 20,
    output_tokens: 7,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
  });
  assert.deepEqual(finished.multi_usage, {
    source: 'provider',
    model: 'native-1',
    effort: 'high',
    reasoning_tokens: 5,
    total_tokens: 32,
  });
  // The stream stopped its block, but the message never ends before the turn is saved.
  assert.equal(events.at(-1)?.[0], 'content_block_stop');
  const terminal = response.takeTerminalEvents();
  assert.deepEqual(
    terminal.map(([name]) => name),
    ['message_delta', 'message_stop'],
  );
  assert.deepEqual(response.takeTerminalEvents(), []);
});

test('a run without usage reports an estimate and keeps its requested input count', () => {
  const { emit } = collector();
  const response = new HarnessResponse('native-1', 11, emit);
  response.text('answer');
  const finished = response.finish(undefined);
  assert.equal(finished.usage.input_tokens, 11);
  assert.ok(finished.usage.output_tokens > 0);
  assert.equal(finished.usage.cache_read_input_tokens, undefined);
  assert.deepEqual(finished.multi_usage, { source: 'estimate' });

  assert.equal(usageSource(undefined), 'estimate');
  assert.equal(usageSource({ input: 1, output: 2 }), 'provider');
  assert.equal(usageSource({ input: 1 }), 'mixed');
  assert.equal(usageSource({}), 'mixed');
});

test('a display row interrupts the text block and carries no executable tool input', () => {
  const { events, emit } = collector();
  const response = new HarnessResponse('native-1', 3, emit, { multiBlock: true });
  response.text('before');
  response.displayRow(row);
  response.text('after');
  const finished = response.finish({ input: 1, output: 1 });
  assert.deepEqual(finished.content, [
    { type: 'text', text: 'before' },
    { type: 'tool_use', id: 'toolu_1', name: 'NativeProgress', input: row.input },
    { type: 'text', text: 'after' },
  ]);
  // The row opens with an empty input, so a partial stream can never be executed.
  const start = events.find(
    ([name, value]) => name === 'content_block_start' && 'index' in value && value.index === 1,
  );
  assert.deepEqual(start?.[1], {
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'NativeProgress', input: {} },
  });
  assert.deepEqual(
    events.map(([name]) => name),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
    ],
  );
  assert.equal(finished.content.at(-1)?.type, 'text');
});

test('a single-block response refuses display rows', () => {
  const { emit } = collector();
  const response = new HarnessResponse('native-1', 3, emit);
  assert.throws(() => response.displayRow(row), /does not emit native display rows/);
});

test('output beyond the safety limit fails the run instead of buffering it', () => {
  const { emit } = collector();
  const response = new HarnessResponse('native-1', 3, emit);
  const chunk = 'x'.repeat(1024 * 1024);
  assert.throws(() => {
    for (let index = 0; index < 33; index += 1) {
      response.text(chunk);
    }
  }, /32 MiB output limit/);
});

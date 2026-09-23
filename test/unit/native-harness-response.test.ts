import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commitHarnessResponse } from '../../plugins/multi-core/src/gateway/harness-completion.ts';
import {
  ExchangeRegistry,
  type HarnessEvent,
} from '../../plugins/multi-core/src/gateway/harness-exchange.ts';
import {
  HarnessResponse,
  type HarnessUsageFields,
  usageSource,
} from '../../plugins/multi-core/src/gateway/harness-response.ts';
import {
  type HarnessSessionBase,
  HarnessSessionStore,
} from '../../plugins/multi-core/src/gateway/harness-session.ts';
import type { Emit } from '../../plugins/multi-core/src/gateway/messages.ts';

function collector() {
  const events: HarnessEvent[] = [];
  const emit: Emit = (name, value) => events.push([name, structuredClone(value)]);
  return { events, emit };
}

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

test('a failed completion write rolls state back and emits no terminal events', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-completion-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  type Saved = HarnessSessionBase & { version: 1; marker: string };
  const store = new HarnessSessionStore<Saved>({
    provider: 'native',
    stateDirectory: directory,
    platform: 'linux',
    version: 1,
    runtime: () => ({}),
    fresh: (identity) => ({
      version: 1,
      provider: 'native',
      identity,
      interrupted: true,
      marker: 'before',
    }),
    validate: () => true,
  });
  const lease = await store.acquireLease('worker');
  const streamed = collector();
  const response = new HarnessResponse('native-1', 1, streamed.emit);
  response.text('answer');
  const finished = response.finish({ input: 1, output: 1 });
  const terminal = collector();
  const registry = new ExchangeRegistry({ provider: 'Native', createMeta: () => ({}) });
  const exchange = registry.start('key', async () => finished);
  store.save = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(
    commitHarnessResponse({
      session: lease.session,
      store,
      response,
      finished,
      exchange,
      key: 'a'.repeat(64),
      emit: terminal.emit,
      update: (saved) => {
        saved.interrupted = false;
        saved.marker = 'after';
      },
    }),
    /disk full/,
  );
  assert.equal(lease.session.saved.interrupted, true);
  assert.equal(lease.session.saved.marker, 'before');
  assert.equal(lease.session.saved.response, undefined);
  assert.deepEqual(terminal.events, []);
  await exchange.result;
  await lease.release();
  await store.closeAll();
});

test('a native response constructs text blocks only, never a tool block', () => {
  const { events, emit } = collector();
  const response = new HarnessResponse('native-1', 3, emit);
  response.text('before');
  response.text(' after');
  const finished = response.finish({ input: 1, output: 1 });
  assert.deepEqual(finished.content, [{ type: 'text', text: 'before after' }]);
  assert.equal(
    events.some(
      ([name, value]) =>
        name === 'content_block_start' &&
        'content_block' in value &&
        (value.content_block as { type?: string }).type === 'tool_use',
    ),
    false,
  );
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

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ExchangeRegistry,
  type HarnessEvent,
  type HarnessExchange,
  replayPersisted,
} from '../../plugins/multi-core/src/gateway/harness-exchange.ts';
import { atomicJson } from '../../plugins/multi-core/src/gateway/harness-session.ts';
import type { Emit, MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';

const key = 'b'.repeat(64);

function answer(text = 'done'): MessagesResponse {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'native-1',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 4 },
  };
}

function collector() {
  const events: HarnessEvent[] = [];
  const emit: Emit = (name, value) => events.push([name, value]);
  return { events, emit };
}

test('one native run serves every identical request and replays what it already emitted', async () => {
  const registry = new ExchangeRegistry<{ mayHaveRun?: boolean }>({
    provider: 'Native',
    createMeta: () => ({}),
  });
  const started = Promise.withResolvers<MessagesResponse>();
  const exchange = registry.start(key, async (_exchange, emit) => {
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } });
    return await started.promise;
  });
  assert.equal(registry.get(key), exchange);
  assert.deepEqual(registry.all(), [exchange]);

  const first = collector();
  const second = collector();
  const one = registry.observe(exchange, new AbortController().signal, first.emit);
  await Promise.resolve();
  const two = registry.observe(exchange, new AbortController().signal, second.emit);
  started.resolve(answer());
  assert.equal((await one).content[0]?.type, 'text');
  await two;
  // The late observer received the delta the run had already emitted.
  assert.deepEqual(first.events, second.events);
  assert.equal(first.events.length, 1);
  assert.equal(registry.get(key), undefined);
});

test('the last observer leaving cancels the native run', async () => {
  const registry = new ExchangeRegistry({ provider: 'Native', createMeta: () => ({}) });
  const reasons: unknown[] = [];
  const exchange = registry.start(key, (running) => {
    running.controller.signal.addEventListener('abort', () => {
      reasons.push(running.controller.signal.reason);
    });
    return new Promise<MessagesResponse>(() => {});
  });
  const controller = new AbortController();
  const observed = registry.observe(exchange, controller.signal);
  controller.abort(new Error('client went away'));
  await assert.rejects(observed, /client went away/);
  assert.equal(reasons.length, 1);
  assert.match(String(reasons[0]), /All Native observers disconnected/);
});

test('an already aborted observer never subscribes', async () => {
  const registry = new ExchangeRegistry({ provider: 'Native', createMeta: () => ({}) });
  const exchange = registry.start(key, async () => answer());
  const controller = new AbortController();
  controller.abort(new Error('gone'));
  const { emit, events } = collector();
  await assert.rejects(registry.observe(exchange, controller.signal, emit), /gone/);
  assert.equal(events.length, 0);
  await exchange.result;
});

test('a retained exchange stays addressable and an ordinary one is dropped', async () => {
  const registry = new ExchangeRegistry<{ mayHaveRun?: boolean }>({
    provider: 'Native',
    createMeta: () => ({}),
  });
  const retain = (exchange: HarnessExchange<{ mayHaveRun?: boolean }>) =>
    exchange.meta.mayHaveRun === true;
  const uncertain = registry.start(
    key,
    async (exchange) => {
      exchange.meta.mayHaveRun = true;
      throw new Error('native run failed after it may have started');
    },
    { retain },
  );
  await assert.rejects(uncertain.result);
  assert.equal(registry.get(key), uncertain);
  assert.equal(uncertain.settled, true);

  const other = 'c'.repeat(64);
  const done = registry.start(other, async () => answer(), { retain });
  await done.result;
  assert.equal(registry.get(other), undefined);
});

test('a completed identical request replays from the session record', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-exchange-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events: HarnessEvent[] = [['message_stop', {}]];
  const { emit, events: seen } = collector();
  const replayed = await replayPersisted({
    stateDirectory: directory,
    key,
    saved: { replay: { key, events }, response: answer() },
    emit,
    provider: 'Native',
  });
  assert.equal(replayed?.multi_usage?.replayed, true);
  assert.equal(replayed?.multi_usage?.source, 'unavailable');
  assert.deepEqual(seen, events);
});

test('a completed identical request replays from its response file', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-exchange-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, `${key}.response.json`);
  const events: HarnessEvent[] = [['message_stop', {}]];
  const response = { ...answer(), multi_usage: { source: 'provider' as const } };
  await atomicJson(file, { response, events }, 'linux');

  const { emit, events: seen } = collector();
  const replayed = await replayPersisted({
    stateDirectory: directory,
    key,
    saved: { replay: { key: 'd'.repeat(64), events: [] } },
    emit,
    provider: 'Native',
  });
  assert.deepEqual(replayed?.multi_usage, { source: 'provider', replayed: true });
  assert.deepEqual(seen, events);

  // A request nothing was recorded for runs; an unreadable record never does.
  assert.equal(
    await replayPersisted({
      stateDirectory: directory,
      key: 'e'.repeat(64),
      emit,
      provider: 'Native',
    }),
    undefined,
  );
  await atomicJson(file, { response: { id: 'msg_2' }, events }, 'linux');
  await assert.rejects(
    replayPersisted({ stateDirectory: directory, key, emit, provider: 'Native' }),
    /Invalid persisted Native response/,
  );
});

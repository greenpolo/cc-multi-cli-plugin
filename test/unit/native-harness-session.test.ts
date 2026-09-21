import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { HarnessEvent } from '../../plugins/multi-core/src/gateway/harness-exchange.ts';
import {
  atomicJson,
  HarnessBusyError,
  type HarnessSessionBase,
  HarnessSessionStore,
  isHash,
  isRecord,
  optionalCount,
  readJson,
  validMessagesResponse,
  validPersistedResponse,
  validReplay,
} from '../../plugins/multi-core/src/gateway/harness-session.ts';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';

type Saved = HarnessSessionBase & { version: 1; sessionId?: string };

const key = 'a'.repeat(64);

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

const events: HarnessEvent[] = [['message_stop', {}]];

async function store(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const made = new HarnessSessionStore<Saved>({
    provider: 'native',
    stateDirectory: directory,
    platform: 'linux',
    version: 1,
    fresh: (identity) => ({ version: 1, provider: 'native', identity, interrupted: false }),
    validate: (saved) => saved.sessionId === undefined || typeof saved.sessionId === 'string',
  });
  t.after(() => made.closeAll());
  return { directory, made };
}

test('a busy identity is refused without a queue and without touching the record', async (t) => {
  const { made } = await store(t);
  const session = await made.acquire('worker-a');
  session.sessionId = 'native-session';
  session.interrupted = true;

  await assert.rejects(made.acquire('worker-a'), (error: unknown) => {
    assert.ok(error instanceof HarnessBusyError);
    assert.match(error.message, /already running for this native agent/);
    return true;
  });
  // The refused request changed nothing: no rewind, no fresh record, still busy.
  assert.equal(session.sessionId, 'native-session');
  assert.equal(session.interrupted, true);
  assert.equal(session.busy, true);
  assert.deepEqual([...made.sessions()], [session]);

  made.release(session);
  const again = await made.acquire('worker-a');
  assert.equal(again, session);
  assert.equal(again.busy, true);
});

test('a second loader is refused while the first load is in flight', async (t) => {
  const { made } = await store(t);
  const first = made.loadOnly('worker-b');
  const second = made.loadOnly('worker-b');
  const [loaded, refused] = await Promise.allSettled([first, second]);
  assert.equal(loaded.status, 'fulfilled');
  assert.equal(refused.status, 'rejected');
  assert.ok(refused.reason instanceof HarnessBusyError);
  assert.match(String(refused.reason.message), /already loading this native agent/);
  // A loaded record is handed back without a second lock acquisition.
  assert.equal(await made.loadOnly('worker-b'), loaded.value);
  assert.equal(loaded.value.busy, false);
});

test('a saved session replays from disk and drops its runtime keys', async (t) => {
  const { directory, made } = await store(t);
  const session = await made.acquire('worker-c');
  session.response = answer();
  session.replay = { key, events };
  session.sessionId = 'native-session';
  session.interrupted = true;
  await made.save(session);
  made.release(session);

  const written = JSON.parse(await readFile(session.file, 'utf8'));
  assert.deepEqual(Object.keys(written).sort(), [
    'identity',
    'interrupted',
    'provider',
    'replay',
    'response',
    'sessionId',
    'version',
  ]);

  const next = new HarnessSessionStore<Saved>({
    provider: 'native',
    stateDirectory: directory,
    platform: 'linux',
    version: 1,
    fresh: (identity) => ({ version: 1, provider: 'native', identity, interrupted: false }),
    validate: () => true,
  });
  t.after(() => next.closeAll());
  await made.closeAll();
  const resumed = await next.loadOnly('worker-c');
  assert.equal(resumed.sessionId, 'native-session');
  assert.equal(resumed.interrupted, true);
  assert.deepEqual(resumed.replay, { key, events });
});

test('an unknown version starts fresh and invalid state refuses native replay', async (t) => {
  const { directory, made } = await store(t);
  const session = await made.acquire('worker-d');
  const file = session.file;
  await made.save(session);
  await made.closeAll();

  await atomicJson(file, { version: 9, provider: 'native', identity: 'worker-d' }, 'linux');
  const fresh = await made.loadOnly('worker-d');
  assert.equal(fresh.interrupted, false);
  assert.equal(fresh.sessionId, undefined);
  await made.closeAll();

  await atomicJson(
    file,
    { version: 1, provider: 'native', identity: 'worker-d', interrupted: 'yes' },
    'linux',
  );
  await assert.rejects(made.loadOnly('worker-d'), /native session has invalid state/);
  await made.closeAll();

  // A provider field check refuses too, and the lock is released on the way out.
  await atomicJson(
    file,
    { version: 1, provider: 'native', identity: 'worker-d', interrupted: false, sessionId: 7 },
    'linux',
  );
  await assert.rejects(made.loadOnly('worker-d'), /native session has invalid state/);
  assert.equal(await readJson(path.join(directory, 'missing.json')), undefined);
});

test('a released lock is released once and a closed store keeps no records', async (t) => {
  const { made } = await store(t);
  const session = await made.acquire('worker-e');
  let releases = 0;
  const original = session.release;
  session.release = () => {
    releases += 1;
    return original();
  };
  await made.releaseLock(session);
  await made.releaseLock(session);
  assert.equal(releases, 1);
  await made.closeAll();
  assert.deepEqual([...made.sessions()], []);
});

test('persisted state is validated before it is trusted', async (t) => {
  const { directory } = await store(t);
  assert.ok(isHash(key));
  assert.equal(isHash('short'), false);
  assert.ok(isRecord({}));
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.ok(optionalCount(undefined));
  assert.ok(optionalCount(4));
  assert.equal(optionalCount(-1), false);
  assert.equal(optionalCount(1.5), false);

  assert.ok(validMessagesResponse(answer()));
  assert.equal(validMessagesResponse({ ...answer(), role: 'user' }), false);
  assert.equal(validMessagesResponse({ ...answer(), usage: { input_tokens: 1 } }), false);
  assert.equal(
    validMessagesResponse({ ...answer(), content: [{ type: 'tool_use', id: 'x', name: 'y' }] }),
    false,
  );

  assert.ok(validReplay({ key, events }));
  assert.equal(validReplay({ key: 'nope', events }), false);
  assert.equal(validReplay({ key, events: [['not_an_event', {}]] }), false);
  assert.equal(validReplay({ key, events: [['message_stop']] }), false);

  assert.ok(validPersistedResponse({ response: answer(), events }));
  assert.equal(validPersistedResponse({ response: answer() }), false);
  assert.equal(validPersistedResponse('nope'), false);

  const file = path.join(directory, 'value.json');
  await atomicJson(file, { hello: 'world' }, 'linux');
  assert.deepEqual(await readJson(file), { hello: 'world' });
  await writeFile(file, '{oops', 'utf8');
  await assert.rejects(readJson(file));
});

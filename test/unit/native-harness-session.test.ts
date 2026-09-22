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
    runtime: () => ({}),
    fresh: (identity) => ({ version: 1, provider: 'native', identity, interrupted: false }),
    validate: (saved) => saved.sessionId === undefined || typeof saved.sessionId === 'string',
  });
  t.after(() => made.closeAll());
  return { directory, made };
}

test('a busy identity is refused without a queue and without touching the record', async (t) => {
  const { made } = await store(t);
  const lease = await made.acquireLease('worker-a');
  const { session } = lease;
  session.saved.sessionId = 'native-session';
  session.saved.interrupted = true;

  await assert.rejects(made.acquireLease('worker-a'), (error: unknown) => {
    assert.ok(error instanceof HarnessBusyError);
    assert.match(error.message, /already running for this native agent/);
    return true;
  });
  // The refused request changed nothing: no rewind, no fresh record, still busy.
  assert.equal(session.saved.sessionId, 'native-session');
  assert.equal(session.saved.interrupted, true);
  assert.equal(session.busy, true);
  assert.deepEqual([...made.sessions()], [session]);

  await lease.release();
  const again = await made.acquireLease('worker-a');
  assert.equal(again.session, session);
  assert.equal(again.session.busy, true);
  await again.release();
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

test('loadOnly refuses a busy turn and mixed first-load acquisition has one winner', async (t) => {
  const { made } = await store(t);
  const first = made.acquireLease('worker-mixed');
  const second = made.loadOnly('worker-mixed');
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((item) => item.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof HarnessBusyError);
  if (outcomes[0]?.status === 'fulfilled') {
    await outcomes[0].value.release();
  }
});

test('a record declaring a different identity is refused', async (t) => {
  const { made } = await store(t);
  const file = made.sessionFile('worker-owned');
  await atomicJson(
    file,
    { version: 1, provider: 'native', identity: 'worker-other', interrupted: false },
    'linux',
  );
  await assert.rejects(made.loadOnly('worker-owned'), /invalid state/);
});

test('a restored alias is migrated to the canonical file while both are locked', async (t) => {
  const { directory } = await store(t);
  const identity = 'worker-legacy';
  const legacy = path.join(directory, 'legacy.session.json');
  await atomicJson(
    legacy,
    { version: 1, provider: 'native', identity, interrupted: true, sessionId: 'old' },
    'linux',
  );
  const migrated = new HarnessSessionStore<Saved>({
    provider: 'native',
    stateDirectory: directory,
    platform: 'linux',
    version: 1,
    runtime: () => ({}),
    fresh: (freshIdentity) => ({
      version: 1,
      provider: 'native',
      identity: freshIdentity,
      interrupted: false,
    }),
    validate: () => true,
    aliasFiles: () => [legacy],
    restore: async ({ files, read }) => ({ saved: await read(files[1]), migrated: true }),
  });
  const session = await migrated.loadOnly(identity);
  assert.equal(session.saved.sessionId, 'old');
  assert.deepEqual(await readJson(session.file), session.saved);
  await migrated.closeAll();
});

test('close preserves a busy lock until its lease is released', async (t) => {
  const { directory, made } = await store(t);
  const lease = await made.acquireLease('worker-closing');
  await made.closeAll();
  assert.deepEqual([...made.sessions()], [lease.session]);
  await lease.release();
  assert.deepEqual([...made.sessions()], []);

  const replacement = new HarnessSessionStore<Saved>({
    provider: 'native',
    stateDirectory: directory,
    platform: 'linux',
    version: 1,
    runtime: () => ({}),
    fresh: (identity) => ({ version: 1, provider: 'native', identity, interrupted: false }),
    validate: () => true,
  });
  await replacement.loadOnly('worker-closing');
  await replacement.closeAll();
});

test('acquisition refuses a record closed between load and lease ownership', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-session-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let racing: HarnessSessionStore<Saved>;
  let closing: Promise<void> | undefined;
  racing = new HarnessSessionStore<Saved>({
    provider: 'native',
    stateDirectory: directory,
    platform: 'linux',
    version: 1,
    runtime: () => {
      queueMicrotask(() => {
        closing = racing.closeAll();
      });
      return {};
    },
    fresh: (identity) => ({ version: 1, provider: 'native', identity, interrupted: false }),
    validate: () => true,
  });
  await assert.rejects(racing.acquireLease('worker-race'), /store is closed/);
  await closing;
  assert.deepEqual([...racing.sessions()], []);

  const replacement = new HarnessSessionStore<Saved>({
    provider: 'native',
    stateDirectory: directory,
    platform: 'linux',
    version: 1,
    runtime: () => ({}),
    fresh: (identity) => ({ version: 1, provider: 'native', identity, interrupted: false }),
    validate: () => true,
  });
  await replacement.loadOnly('worker-race');
  await replacement.closeAll();
});

test('save refuses released and foreign sessions', async (t) => {
  const first = await store(t);
  const second = await store(t);
  const session = await first.made.loadOnly('worker-save');
  await assert.rejects(second.made.save(session), /not owned by this store/);
  await first.made.closeAll();
  await assert.rejects(first.made.save(session), /lock has been released/);
});

test('a saved session replays from disk and drops its runtime keys', async (t) => {
  const { directory, made } = await store(t);
  const lease = await made.acquireLease('worker-c');
  const { session } = lease;
  session.saved.response = answer();
  session.saved.replay = { key, events };
  session.saved.sessionId = 'native-session';
  session.saved.interrupted = true;
  await made.save(session);
  await lease.release();

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
    runtime: () => ({}),
    fresh: (identity) => ({ version: 1, provider: 'native', identity, interrupted: false }),
    validate: () => true,
  });
  t.after(() => next.closeAll());
  await made.closeAll();
  const resumed = await next.loadOnly('worker-c');
  assert.equal(resumed.saved.sessionId, 'native-session');
  assert.equal(resumed.saved.interrupted, true);
  assert.deepEqual(resumed.saved.replay, { key, events });
});

test('an unknown version starts fresh and invalid state refuses native replay', async (t) => {
  const { directory, made } = await store(t);
  const lease = await made.acquireLease('worker-d');
  const { session } = lease;
  const file = session.file;
  await made.save(session);
  await lease.release();
  await made.closeAll();

  const reopen = () =>
    new HarnessSessionStore<Saved>({
      provider: 'native',
      stateDirectory: directory,
      platform: 'linux',
      version: 1,
      runtime: () => ({}),
      fresh: (identity) => ({ version: 1, provider: 'native', identity, interrupted: false }),
      validate: (saved) => saved.sessionId === undefined || typeof saved.sessionId === 'string',
    });

  await atomicJson(file, { version: 9, provider: 'native', identity: 'worker-d' }, 'linux');
  const second = reopen();
  const fresh = await second.loadOnly('worker-d');
  assert.equal(fresh.saved.interrupted, false);
  assert.equal(fresh.saved.sessionId, undefined);
  await second.closeAll();

  await atomicJson(
    file,
    { version: 1, provider: 'native', identity: 'worker-d', interrupted: 'yes' },
    'linux',
  );
  const third = reopen();
  await assert.rejects(third.loadOnly('worker-d'), /native session has invalid state/);
  await third.closeAll();

  // A provider field check refuses too, and the lock is released on the way out.
  await atomicJson(
    file,
    { version: 1, provider: 'native', identity: 'worker-d', interrupted: false, sessionId: 7 },
    'linux',
  );
  const fourth = reopen();
  await assert.rejects(fourth.loadOnly('worker-d'), /native session has invalid state/);
  await fourth.closeAll();
  assert.equal(await readJson(path.join(directory, 'missing.json')), undefined);
});

test('closing is idempotent and a closed store keeps no records', async (t) => {
  const { made } = await store(t);
  await made.loadOnly('worker-e');
  await made.closeAll();
  await made.closeAll();
  assert.deepEqual([...made.sessions()], []);
  await assert.rejects(made.loadOnly('worker-e'), /store is closed/);
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

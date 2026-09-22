import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  ModPolicies,
  type PreparedPolicy,
} from '../../plugins/multi-core/src/gateway/mod-policy.ts';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';

const policy: PreparedPolicy = {
  cwd: '/workspace',
  workers: { cursor: { model: 'multi/cursor/auto', tools: ['Read'] } },
  restrictions: { disallowedTools: ['Bash'] },
};

test('policy discovery returns immediately and admits only the ready generation and workspace', async () => {
  let finish: ((value: PreparedPolicy) => void) | undefined;
  const store = new ModPolicies(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = store.begin('s', '/workspace');
  assert.equal(pending.status, 'pending');
  assert.throws(() => store.consume('s', pending.generation, '/workspace'), /not ready/);
  finish?.(policy);
  await setImmediate();
  assert.deepEqual(store.consume('s', pending.generation, '/workspace'), policy);
  assert.throws(() => store.consume('s', pending.generation, '/elsewhere'), /not ready/);
  store.forget('s');
  assert.throws(() => store.consume('s', pending.generation, '/workspace'), /stale/);
});

test('late policy discovery cannot overwrite a newer prompt generation', async () => {
  const finishes: Array<(value: PreparedPolicy) => void> = [];
  const store = new ModPolicies(
    () =>
      new Promise((resolve) => {
        finishes.push(resolve);
      }),
  );
  const old = store.begin('s', '/old');
  const latest = store.begin('s', '/workspace');
  finishes[1](policy);
  finishes[0]({ ...policy, cwd: '/old' });
  await setImmediate();
  assert.throws(() => store.consume('s', old.generation, '/old'), /stale/);
  assert.deepEqual(store.consume('s', latest.generation, '/workspace'), policy);
});

test('worker admission rejects inconsistent identity and native dispatch awaits child acknowledgement', async () => {
  const modes = new PermissionModes(async () => policy.workers);
  await modes.precompute('/workspace');
  modes.recordModSession('s', { permissionMode: 'plan', cwd: '/workspace', model: 'parent' });
  const spawn = {
    subagentType: 'cursor',
    cwd: '/workspace',
    permissionMode: 'plan',
    parentModel: 'parent',
  };
  for (const change of [
    { subagentType: 'unknown' },
    { model: 'wrong' },
    { parentModel: 'multi/cursor/wrong' },
    { parentAgentId: 'unknown' },
    { permissionMode: 'bypassPermissions' },
    { cwd: '/other' },
  ]) {
    await assert.rejects(modes.prepareModWorker('s', { ...spawn, ...change }));
  }
  await modes.prepareModWorker('s', spawn);
  assert.throws(() => modes.resolve('s', 'worker'), /unavailable/);
  modes.startPreparedModWorker('s', 'worker', 'cursor', '/workspace');
  assert.deepEqual(modes.resolve('s', 'worker').tools, ['Read']);
  assert.throws(() => modes.startPreparedModWorker('s', 'other', 'cursor', '/workspace'), /unique/);
});

test('a worker spawned by its plain model ID matches its tagged catalog definition', async () => {
  const modes = new PermissionModes(async () => ({
    gemini: { model: 'multi/antigravity/gemini[1m]', tools: ['Read'] },
  }));
  await modes.precompute('/workspace');
  modes.recordModSession('s', {
    permissionMode: 'plan',
    cwd: '/workspace',
    model: 'multi/antigravity/gemini[1m]',
  });
  const spawn = {
    subagentType: 'gemini',
    cwd: '/workspace',
    permissionMode: 'plan',
    parentModel: 'multi/antigravity/gemini',
  };
  // The tag is Claude-side presentation, so a caller that spells the model without it is
  // naming the same native model, not a different one.
  await modes.prepareModWorker('s', { ...spawn, model: 'multi/antigravity/gemini' });
  await assert.rejects(
    modes.prepareModWorker('s', { ...spawn, model: 'multi/antigravity/other' }),
    /inconsistent with its catalog definition/,
  );
});

test('host-only snapshots cannot authorize harness workers until policy admission', async () => {
  const modes = new PermissionModes(
    async () => ({
      cursor: { model: 'multi/cursor/auto', tools: ['Read'] },
      native: { model: 'claude-sonnet-5', disallowedTools: ['Edit'] },
    }),
    async () => ({ disallowedTools: ['Bash'] }),
  );
  await modes.precompute('/workspace');
  modes.recordHostSession('s', {
    permissionMode: 'auto',
    cwd: '/workspace',
    model: 'multi/cursor/auto',
  });
  assert.throws(() => modes.resolveHarness('s'), /settings policy has not been admitted/);
  assert.throws(() => modes.resolveHarness('s'), /Workflow.*Agent tool/);
  assert.throws(
    () => modes.resolveHarness('s', 'unacknowledged-worker', 'multi/cursor/auto'),
    /no acknowledged spawn.*Workflow.*Agent tool/,
  );
  assert.throws(() => modes.authorizeModCompaction('s'), /settings policy has not been admitted/);
  await assert.rejects(
    modes.prepareModWorker('s', {
      subagentType: 'cursor',
      cwd: '/workspace',
      permissionMode: 'auto',
      model: 'multi/cursor/auto',
      parentModel: 'multi/cursor/auto',
    }),
    /settings policy has not been admitted/,
  );

  const pending = modes.beginPolicy('s', '/workspace');
  await setImmediate();
  modes.admitPolicy('s', pending.generation, {
    permissionMode: 'auto',
    cwd: '/workspace',
    model: 'multi/cursor/auto',
  });
  const parentToken = await modes.prepareModWorker('s', {
    subagentType: 'native',
    cwd: '/workspace',
    permissionMode: 'auto',
    model: 'multi/cursor/auto',
    parentModel: 'multi/cursor/auto',
  });
  modes.startPreparedModWorker('s', 'parent', 'native', '/workspace');
  assert.deepEqual(
    new Set(modes.resolve('s', 'parent').disallowedTools),
    new Set(['Bash', 'Edit']),
  );
  assert.throws(() => modes.resolveHarness('s', 'parent', 'multi/cursor/other'), /inconsistent/);
  const childToken = await modes.prepareModWorker('s', {
    subagentType: 'cursor',
    cwd: '/workspace',
    permissionMode: 'auto',
    model: 'multi/cursor/auto',
    parentModel: 'claude-sonnet-5',
    parentAgentId: 'parent',
  });
  modes.startPreparedModWorker('s', 'child', 'cursor', '/workspace');
  assert.deepEqual(
    new Set(modes.resolveHarness('s', 'child', 'multi/cursor/auto').disallowedTools),
    new Set(['Bash', 'Edit']),
  );
  assert.equal(typeof parentToken, 'string');
  assert.equal(typeof childToken, 'string');
});

test('Claude-loop workers use the prompt snapshot without settings-policy admission', async () => {
  const modes = new PermissionModes(async () => ({
    'openai-native': { model: 'multi/openai/gpt-6-astra' },
    custom: { tools: ['Read'] },
  }));
  await modes.precompute('/workspace');
  modes.recordHostSession('s', {
    permissionMode: 'default',
    cwd: '/workspace',
    model: 'claude-sonnet-4-6',
  });
  const token = await modes.prepareModWorker('s', {
    subagentType: 'openai-native',
    cwd: '/workspace',
    model: 'multi/openai/gpt-6-astra',
    permissionMode: 'default',
    parentModel: 'claude-sonnet-4-6',
  });
  modes.startPreparedModWorker('s', 'worker', 'openai-native', '/workspace');
  assert.equal(modes.resolve('s', 'worker').model, 'multi/openai/gpt-6-astra');
  assert.equal(
    modes.workerSelection({ subagentType: 'custom', cwd: '/workspace' }).execution,
    'claude',
  );
  assert.equal(typeof token, 'string');
});

test('ambiguous simultaneous worker starts fail closed and catalog filtering preserves known workers', async () => {
  const modes = new PermissionModes(async () => ({
    ...policy.workers,
    unsupported: { nativePermissionError: 'unsupported' },
  }));
  await modes.precompute('/workspace');
  modes.recordModSession('s', { permissionMode: 'auto', cwd: '/workspace' });
  const spawn = { subagentType: 'cursor', cwd: '/workspace', permissionMode: 'auto' };
  await modes.prepareModWorker('s', spawn);
  await modes.prepareModWorker('s', spawn);
  assert.throws(
    () => modes.startPreparedModWorker('s', 'worker', 'cursor', '/workspace'),
    /unique/,
  );
  assert.equal(modes.offered('/workspace', 'cursor'), true);
  assert.equal(modes.offered('/workspace', 'unsupported'), false);
  assert.equal(modes.offered('/workspace', 'unknown'), false);
});

test('worker contexts retain the authenticated compaction deny marker and parent restrictions', async () => {
  const modes = new PermissionModes(async () => policy.workers);
  await modes.precompute('/workspace');
  modes.recordModSession('s', {
    permissionMode: 'auto',
    cwd: '/workspace',
    disallowedTools: ['Bash'],
  });
  await modes.prepareModWorker('s', {
    subagentType: 'cursor',
    cwd: '/workspace',
    permissionMode: 'auto',
  });
  modes.startPreparedModWorker('s', 'worker', 'cursor', '/workspace');
  modes.authorizeModCompaction('s');
  assert.equal(modes.resolve('s', 'worker').compaction, modes.resolve('s').compaction);
  assert.deepEqual(modes.resolve('s', 'worker').disallowedTools, ['Bash']);
  modes.forgetSession('s');
  assert.throws(() => modes.resolve('s', 'worker'), /unavailable/);
});

test('a policy discovery that outlasts the hook is reused on retry until admitted', async () => {
  let finish: ((value: PreparedPolicy) => void) | undefined;
  let discoveries = 0;
  const store = new ModPolicies(() => {
    discoveries++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const first = store.begin('s', '/workspace');
  assert.equal(store.begin('s', '/workspace').generation, first.generation);
  finish?.(policy);
  await setImmediate();
  assert.equal(store.begin('s', '/workspace').generation, first.generation);
  store.consume('s', first.generation, '/workspace');
  assert.notEqual(store.begin('s', '/workspace').generation, first.generation);
  assert.equal(discoveries, 2);
  finish?.(policy);
});

test('successful worker compaction restores ordinary restrictions without restoring a stale prompt', async () => {
  const modes = new PermissionModes(async () => policy.workers);
  await modes.precompute('/workspace');
  modes.recordModSession('s', { permissionMode: 'plan', cwd: '/workspace' });
  await modes.prepareModWorker('s', {
    subagentType: 'cursor',
    cwd: '/workspace',
    permissionMode: 'plan',
  });
  modes.startPreparedModWorker('s', 'worker', 'cursor', '/workspace');
  modes.authorizeModCompaction('s', 'worker');
  const id = modes.resolve('s', 'worker').compaction;
  assert.deepEqual(modes.resolve('s', 'worker').tools, []);
  modes.finishModCompaction('s', 'worker', id);
  assert.deepEqual(modes.resolve('s', 'worker').tools, ['Read']);
  assert.equal(modes.resolve('s', 'worker').compaction, undefined);
  modes.authorizeModCompaction('s');
  const parentId = modes.resolve('s').compaction;
  modes.recordModSession('s', { permissionMode: 'auto', cwd: '/workspace' });
  modes.finishModCompaction('s', undefined, parentId);
  assert.equal(modes.resolve('s').permissionMode, 'auto');
});

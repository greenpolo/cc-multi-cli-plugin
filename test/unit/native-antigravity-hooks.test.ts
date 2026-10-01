import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  antigravityHookDefinition,
  antigravityHookFile,
  antigravitySettingsFile,
  installAntigravityHook,
} from '../../plugins/multi-antigravity/src/hooks.ts';
import { removeAntigravityHook } from '../../plugins/multi-core/src/install/installation.ts';
import { removeTemporary } from '../temporary.ts';

interface InstalledPreToolUseHook {
  PreToolUse: Array<{
    matcher: string;
    hooks: Array<{ type: string; command: string; timeout: number }>;
  }>;
}

async function fixture(t: test.TestContext, value: Record<string, unknown>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'antigravity-hooks-'));
  const file = path.join(directory, 'hooks.json');
  await writeFile(file, `${JSON.stringify(value)}\n`);
  t.after(() => removeTemporary(directory));
  return { file, value };
}

/** The exact shape `definition()` in hooks.ts must produce; a dummy install must fail every line. */
function assertNamespacedHook(installed: Record<string, unknown>) {
  const hook = installed['multi-cli-antigravity'] as InstalledPreToolUseHook;
  assert.equal(hook.PreToolUse.length, 1);
  assert.equal(hook.PreToolUse[0].matcher, '*');
  assert.equal(hook.PreToolUse[0].hooks.length, 1);
  assert.equal(hook.PreToolUse[0].hooks[0].type, 'command');
  assert.equal(hook.PreToolUse[0].hooks[0].timeout, 10);
  assert.match(hook.PreToolUse[0].hooks[0].command, /permission-hook\.ts/);
}

test('Antigravity hook installation preserves non-PreToolUse hooks', async (t) => {
  const original = {
    audit: {
      PermissionRequest: [{ hooks: [{ type: 'command', command: 'record-audit' }] }],
    },
  };
  const { file } = await fixture(t, original);
  await installAntigravityHook(file);
  const installed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(installed.audit, original.audit);
  assertNamespacedHook(installed);
  const mode = (await stat(file)).mode & 0o777;
  if (process.platform !== 'win32') {
    assert.equal(mode, 0o600);
  }
  await installAntigravityHook(file);
  const reinstalled = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(reinstalled, installed);
});

test('Antigravity hook installation coexists with another active PreToolUse hook', async (t) => {
  const original = {
    other: {
      PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'other' }] }],
    },
  };
  const { file } = await fixture(t, original);
  await installAntigravityHook(file);
  const installed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(installed.other, original.other);
  assertNamespacedHook(installed);
  const mode = (await stat(file)).mode & 0o777;
  if (process.platform !== 'win32') {
    assert.equal(mode, 0o600);
  }
  await installAntigravityHook(file);
  const reinstalled = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(reinstalled, installed);
});

test('Antigravity resolves native config roots and direct Node hook commands per platform', async () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' };
  assert.equal(
    antigravityHookFile({ platform: 'win32', env, homedir: 'C:\\Users\\tester' }),
    'C:\\Users\\tester\\AppData\\Local\\gemini\\config\\hooks.json',
  );
  assert.equal(
    antigravitySettingsFile({ platform: 'darwin', homedir: '/Users/tester' }),
    '/Users/tester/.gemini/antigravity-cli/settings.json',
  );
  const posix = antigravityHookDefinition('linux').PreToolUse[0].hooks[0].command;
  assert.match(
    posix,
    /^if \[ "\$\{MULTI_ANTIGRAVITY_DENY\+x}" = x ]; then .*permission-hook\.ts.*; fi$/,
  );
  const windows = antigravityHookDefinition('win32').PreToolUse[0].hooks[0].command;
  assert.doesNotMatch(windows, /if \[/);
  assert.match(windows, /permission-hook\.ts/);
});

test('Antigravity replaces an existing Windows destination', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'antigravity-win-hooks-'));
  const file = path.join(directory, 'hooks.json');
  await writeFile(file, JSON.stringify({ old: true }));
  t.after(() => removeTemporary(directory));
  await installAntigravityHook(file, { platform: 'win32' });
  const installed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.equal(installed.old, true);
  assert.ok(installed['multi-cli-antigravity']);
});

test('uninstall removes only the Multi Antigravity hook entry and tolerates a missing file', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'antigravity-uninstall-'));
  t.after(() => removeTemporary(home));
  assert.equal(await removeAntigravityHook({ platform: 'linux', homedir: home }), false);
  const file = antigravityHookFile({ platform: 'linux', homedir: home });
  await installAntigravityHook(file);
  const other = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'other' }] }] };
  const installed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, `${JSON.stringify({ ...installed, other })}\n`);
  assert.equal(await removeAntigravityHook({ platform: 'linux', homedir: home }), true);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { other });
  assert.equal(await removeAntigravityHook({ platform: 'linux', homedir: home }), false);
});

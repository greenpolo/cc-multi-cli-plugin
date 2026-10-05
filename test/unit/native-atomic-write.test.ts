import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicWriteFile } from '../../plugins/multi-core/src/gateway/atomic-write.ts';
import { removeTemporary } from '../temporary.ts';

test('atomicWriteFile replaces files on Unix and retries Windows sharing errors', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atomic-write-'));
  t.after(() => removeTemporary(directory));
  const file = path.join(directory, 'state.json');
  await writeFile(file, 'old');
  await atomicWriteFile(file, 'new', { platform: 'linux' });
  assert.equal(await readFile(file, 'utf8'), 'new');
});

test('retries a transient Windows rename sharing violation', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atomic-write-win-'));
  t.after(() => removeTemporary(directory));
  const file = path.join(directory, 'state.json');
  let failures = 1;
  await atomicWriteFile(file, 'new', {
    platform: 'win32',
    rename: async (temporary, target) => {
      if (failures > 0) {
        failures -= 1;
        const error = new Error('sharing violation') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      const { rename } = await import('node:fs/promises');
      await rename(temporary, target);
    },
  });
  assert.equal(failures, 0);
  assert.equal(await readFile(file, 'utf8'), 'new');
});

test('rejects an unbounded retry configuration', async () => {
  await assert.rejects(
    atomicWriteFile(path.join(os.tmpdir(), 'unused-atomic-write-test'), 'data', {
      retries: Infinity,
    }),
    /retries must be a non-negative integer/,
  );
});

test('syncs the temporary file before rename and the directory after, except on Windows', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atomic-write-sync-'));
  t.after(() => removeTemporary(directory));
  for (const platform of ['linux', 'win32'] as const) {
    const events: string[] = [];
    const spyOpen = (async (target: string, flags: string, mode?: number) => {
      const handle = await open(target, flags, mode);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push(`sync:${target === directory ? 'dir' : 'tmp'}`);
        await sync();
      };
      return handle;
    }) as typeof open;
    await atomicWriteFile(path.join(directory, 'state.json'), 'v', {
      platform,
      open: spyOpen,
      rename: async (from, to) => {
        events.push('rename');
        const { rename } = await import('node:fs/promises');
        await rename(from, to);
      },
    });
    assert.deepEqual(
      events,
      platform === 'win32' ? ['sync:tmp', 'rename'] : ['sync:tmp', 'rename', 'sync:dir'],
    );
  }
});

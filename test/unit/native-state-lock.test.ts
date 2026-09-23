import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os, { hostname } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { lockStateFile } from '../../plugins/multi-core/src/gateway/state-lock.ts';
import { removeTemporary } from '../temporary.ts';

async function temporaryDirectory(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => removeTemporary(directory));
  return directory;
}

test('acquires, excludes concurrent owners, and releases a state lock', async (t) => {
  const directory = await temporaryDirectory(t, 'multi-state-lock-');
  const file = path.join(directory, 'session.lock');
  const release = await lockStateFile(file);
  const metadata = JSON.parse(await readFile(file, 'utf8')) as { pid: number; token: string };
  assert.equal(metadata.pid, process.pid);
  assert.ok(metadata.token);
  await assert.rejects(lockStateFile(file), /locked/);
  await release();
  const nextRelease = await lockStateFile(file);
  await nextRelease();
});

test('legacy directory locks remain explicit recovery evidence', async (t) => {
  const directory = await temporaryDirectory(t, 'multi-legacy-lock-');
  const file = path.join(directory, 'session.lock');
  await mkdir(file);
  await assert.rejects(lockStateFile(file), /legacy interrupted lock/);
});

test('waits for an owner that is still writing its marker', async (t) => {
  const directory = await temporaryDirectory(t, 'multi-partial-lock-');
  const file = path.join(directory, 'session.lock');
  await writeFile(file, '', { mode: 0o600 });
  const writing = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      writeFile(
        file,
        `${JSON.stringify({ pid: process.pid, hostname: hostname(), token: 'writing' })}\n`,
      ).then(resolve, reject);
    }, 30);
  });
  await assert.rejects(lockStateFile(file), /locked by another gateway/);
  await writing;
});

test('does not take over a lock recorded on another hostname', async (t) => {
  const directory = await temporaryDirectory(t, 'multi-foreign-lock-');
  const file = path.join(directory, 'session.lock');
  await writeFile(
    file,
    `${JSON.stringify({ pid: 2147483647, hostname: 'another-host', token: 'foreign' })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(lockStateFile(file), /locked by another gateway/);
});

test('takes over a lock whose recorded owner is no longer alive', async (t) => {
  const directory = await temporaryDirectory(t, 'multi-stale-lock-');
  const file = path.join(directory, 'session.lock');
  await writeFile(
    file,
    `${JSON.stringify({ pid: 2147483647, hostname: hostname(), token: 'stale' })}\n`,
    { mode: 0o600 },
  );
  const release = await lockStateFile(file);
  await release();
});

test('releases after the holder process is killed', { timeout: 10000 }, async (t) => {
  const directory = await temporaryDirectory(t, 'multi-crash-lock-');
  const file = path.join(directory, 'session.lock');
  const module = new URL('../../plugins/multi-core/src/gateway/state-lock.ts', import.meta.url);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {lockStateFile} from ${JSON.stringify(module.href)};const release=await lockStateFile(process.argv[1]);process.stdout.write('ready');process.stdin.on('end',release);process.stdin.resume();`,
      file,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  t.after(() => {
    if (!child.killed) {
      child.kill();
    }
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('close', () => reject(new Error('Lock owner exited before acquisition')));
  });
  await assert.rejects(lockStateFile(file), /locked/);
  child.kill();
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  const release = await lockStateFile(file);
  await release();
});

test('bounds repeated stale-lock takeover races', async (t) => {
  const directory = await temporaryDirectory(t, 'multi-lock-budget-');
  const file = path.join(directory, 'session.lock');
  await writeFile(
    file,
    `${JSON.stringify({ pid: 2147483647, hostname: hostname(), token: 'stale' })}\n`,
  );
  await assert.rejects(lockStateFile(file, { maxAttempts: 1 }), /exceeded 1 attempts/);
  const release = await lockStateFile(file);
  await release();
});

test('bounds transient Windows unlink failures during release', async (t) => {
  const directory = await temporaryDirectory(t, 'multi-lock-unlink-');
  const file = path.join(directory, 'session.lock');
  let failures = 1;
  const release = await lockStateFile(file, {
    platform: 'win32',
    unlink: async (target) => {
      if (failures > 0) {
        failures -= 1;
        const error = new Error('sharing violation') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      await rm(target);
    },
  });
  await release();
  assert.equal(failures, 0);
});

test('supports the Windows lock branch through the injected platform', async (t) => {
  const directory = await temporaryDirectory(t, 'multi-win32-lock-');
  const file = path.join(directory, 'session.lock');
  const release = await lockStateFile(file, { platform: 'win32' });
  await assert.rejects(lockStateFile(file, { platform: 'win32' }), /locked/);
  await release();
  const nextRelease = await lockStateFile(file, { platform: 'win32' });
  await nextRelease();
});

test('recovers when a Windows delete-pending marker vanishes between open and stat', async (t) => {
  const directory = await temporaryDirectory(t, 'multi-lock-delete-pending-');
  const file = path.join(directory, 'session.lock');
  let openAttempts = 0;
  const release = await lockStateFile(file, {
    platform: 'win32',
    open: async (...args) => {
      openAttempts += 1;
      if (openAttempts === 1) {
        const error = new Error('delete pending') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      const { open } = await import('node:fs/promises');
      return open(...args);
    },
    lstat: async () => {
      const error = new Error('gone') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.equal(openAttempts, 2);
  await release();
});

test('rejects non-positive maxAttempts before touching the lock file', async () => {
  let opened = false;
  const open = async () => {
    opened = true;
    throw new Error('lock file must not be opened');
  };
  for (const maxAttempts of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      lockStateFile('/tmp/state.lock', { maxAttempts, open }),
      (error: unknown) => {
        assert.equal(error instanceof RangeError, true);
        assert.match(String(error), /positive integer/);
        return true;
      },
    );
  }
  assert.equal(opened, false);
});

test('an empty marker left by the previous flock-based lock is taken over', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'state-lock-legacy-'));
  t.after(() => removeTemporary(directory));
  const file = path.join(directory, 'state.lock');
  await writeFile(file, '');
  const release = await lockStateFile(file);
  assert.match(await readFile(file, 'utf8'), /"pid"/);
  await release();
});

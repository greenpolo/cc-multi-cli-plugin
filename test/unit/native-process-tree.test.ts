import assert from 'node:assert/strict';
import test from 'node:test';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';

test('terminates POSIX process groups and always attempts the direct PID fallback', () => {
  const calls: [number, NodeJS.Signals | number | undefined][] = [];
  terminateProcessTree(42, {
    platform: 'darwin',
    kill: (pid, signal) => calls.push([pid, signal]),
  });
  assert.deepEqual(calls, [
    [-42, 'SIGTERM'],
    [42, 'SIGTERM'],
  ]);
});

test('uses taskkill tree termination on Windows', () => {
  const calls: [number, boolean][] = [];
  terminateProcessTree(42, {
    platform: 'win32',
    kill: () => assert.fail('Windows must not send POSIX signals'),
    taskkill: (pid, force) => calls.push([pid, force]),
  });
  assert.deepEqual(calls, [[42, true]]);
});

test('Windows asks politely for SIGINT/SIGTERM and forces only for SIGKILL', () => {
  const calls: [number, boolean][] = [];
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
    terminateProcessTree(7, {
      platform: 'win32',
      signal,
      taskkill: (pid, force) => calls.push([pid, force]),
    });
  }
  assert.deepEqual(calls, [
    [7, false],
    [7, false],
    [7, true],
  ]);
});

test('groupOnly never signals the bare PID', () => {
  const calls: number[] = [];
  terminateProcessTree(42, { platform: 'linux', groupOnly: true, kill: (pid) => calls.push(pid) });
  assert.deepEqual(calls, [-42]);
});

test('continues direct POSIX cleanup when group cleanup fails', () => {
  const calls: number[] = [];
  terminateProcessTree(42, {
    platform: 'linux',
    kill: (pid) => {
      calls.push(pid);
      if (pid < 0) {
        throw new Error('no group');
      }
    },
  });
  assert.deepEqual(calls, [-42, 42]);
});

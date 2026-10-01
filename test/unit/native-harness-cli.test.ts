import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedWait, harnessFailure } from '../../plugins/multi-core/src/gateway/harness-cli.ts';
import { HarnessBusyError } from '../../plugins/multi-core/src/gateway/harness-session.ts';

test('boundedWait returns at its timeout without rejecting a slow operation', async () => {
  const started = Date.now();
  await boundedWait(new Promise(() => undefined), 20);
  assert(Date.now() - started < 1000);
  await boundedWait(Promise.resolve('done'), 20);
});

test('harnessFailure caps one line, appends advice, and applies the shared status policy', () => {
  const busy = harnessFailure(new HarnessBusyError('agent already running\nnow'), 'unknown X');
  assert.equal(busy.status, 400);
  assert.equal(busy.message.includes('\n'), false);
  const advised = harnessFailure(new Error('boom'), 'unknown X', () => 'Try again.');
  assert.deepEqual(advised, { status: 502, message: 'boom Try again.' });
  assert.equal(harnessFailure(undefined, 'unknown X').message, 'unknown X');
  assert.equal(harnessFailure(new Error('x'.repeat(900)), 'unknown X').message.length, 500);
});

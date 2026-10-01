import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyHarnessFailure } from '../../plugins/multi-core/src/gateway/harness-failure.ts';
import { NativeCliError } from '../../plugins/multi-core/src/gateway/harness-process.ts';
import { HarnessBusyError } from '../../plugins/multi-core/src/gateway/harness-session.ts';

const status = (error: unknown) => classifyHarnessFailure(error).status;

test('configuration and deterministic failures are request errors', () => {
  assert.equal(status(new HarnessBusyError('busy')), 400);
  assert.equal(status(new NativeCliError('policy', 'policy')), 400);
  assert.equal(status(new NativeCliError('gone', 'spawn', { systemCode: 'ENOENT' })), 400);
  assert.equal(status(new NativeCliError('denied', 'spawn', { systemCode: 'EACCES' })), 400);
  assert.equal(status(Object.assign(new Error('Executable not found'), { code: 'ENOENT' })), 400);
  assert.equal(status(Object.assign(new Error('unsafe'), { code: 'EUNSAFEARG' })), 400);
});

test('transient and uncertain failures stay retryable 502s', () => {
  for (const systemCode of ['EAGAIN', 'EMFILE', 'ENOMEM']) {
    assert.equal(status(new NativeCliError('busy host', 'spawn', { systemCode })), 502);
  }
  for (const code of ['no_terminal_result', 'aborted', 'output_limit', 'parse']) {
    assert.equal(status(new NativeCliError('x', code)), 502);
  }
  assert.equal(status(new Error('unknown')), 502);
  assert.equal(classifyHarnessFailure(new Error('x')).deterministic, false);
});

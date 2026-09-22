import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeHarnessErrorStatus } from '../../plugins/multi-core/src/gateway/native-harness.ts';

test('native harness failures accept only HTTP error statuses and preserve the outer failure', () => {
  const inner = Object.assign(new Error('inner'), { failure: { status: 401 } });
  const outer = Object.assign(new Error('outer', { cause: inner }), { failure: { status: 429 } });
  assert.equal(nativeHarnessErrorStatus(outer), 429);
  assert.equal(nativeHarnessErrorStatus(inner), 401);
  assert.equal(nativeHarnessErrorStatus({ failure: { status: 399 } }), undefined);
  assert.equal(nativeHarnessErrorStatus({ failure: { status: 600 } }), undefined);
  assert.equal(nativeHarnessErrorStatus({ failure: { status: 401.5 } }), undefined);
  assert.equal(nativeHarnessErrorStatus({ failure: { status: '401' } }), undefined);
});

test('native harness failure lookup bounds malformed and cyclic cause chains', () => {
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(nativeHarnessErrorStatus(cyclic), undefined);
  assert.equal(
    nativeHarnessErrorStatus(new Error('wrapper', { cause: { failure: { status: 503 } } })),
    503,
  );
});

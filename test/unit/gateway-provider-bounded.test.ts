import assert from 'node:assert/strict';
import test from 'node:test';
import { addBounded, setBounded } from '../../plugins/multi-core/src/gateway/bounded.ts';
import {
  harnessProvider,
  providerOwnedReview,
  providerRoute,
} from '../../plugins/multi-core/src/gateway/provider.ts';

test('provider prefixes decide routing, review ownership and harness execution in one place', () => {
  assert.equal(providerRoute(null), 'anthropic');
  assert.equal(providerRoute('multi/cursor/auto'), 'cursor');
  assert.equal(providerRoute('multi/zen/glm'), 'zen');
  assert.equal(providerRoute('multi/openai/gpt-6-luna'), 'openai');
  assert.equal(providerRoute('multi/unknown/x'), 'openai');
  assert.equal(harnessProvider('multi/grok/x'), 'grok');
  assert.equal(harnessProvider('multi/openai/x'), undefined);
  assert.equal(harnessProvider(undefined), undefined);
  assert.equal(providerOwnedReview('multi/antigravity/x'), true);
  assert.equal(providerOwnedReview('multi/openai/x'), true);
  assert.equal(providerOwnedReview('multi/zen/x'), false);
  assert.equal(providerOwnedReview('claude-sonnet'), false);
});

test('bounded maps choose between recency and insertion eviction', () => {
  const lru = new Map<string, number>();
  for (const key of ['a', 'b', 'c']) {
    setBounded(lru, key, 1, 3, 'lru');
  }
  setBounded(lru, 'a', 2, 3, 'lru');
  setBounded(lru, 'd', 1, 3, 'lru');
  assert.deepEqual([...lru.keys()], ['c', 'a', 'd']);

  const insertion = new Map<string, number>();
  for (const key of ['a', 'b', 'c']) {
    setBounded(insertion, key, 1, 3, 'insertion');
  }
  setBounded(insertion, 'a', 2, 3, 'insertion');
  assert.deepEqual([...insertion.keys()], ['a', 'b', 'c']);
  assert.equal(insertion.get('a'), 2);
  setBounded(insertion, 'd', 1, 3, 'insertion');
  assert.deepEqual([...insertion.keys()], ['b', 'c', 'd']);

  const set = new Set<string>();
  for (const key of ['a', 'b', 'c', 'd']) {
    addBounded(set, key, 3);
  }
  assert.deepEqual([...set], ['b', 'c', 'd']);
});

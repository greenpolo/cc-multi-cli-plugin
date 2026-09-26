import assert from 'node:assert/strict';
import test from 'node:test';
import { antigravityDefaultWorkerModel } from '../../plugins/multi-antigravity/src/models.ts';
import { resolveWorker } from '../../plugins/multi-core/src/gateway/worker-catalog.ts';
import { workerCatalog, workerDefinitions } from '../../plugins/multi-core/src/launcher.ts';

const rows = [
  'multi/openai/gpt-6-astra',
  'multi/openai/gpt-6-luna',
  'multi/cursor/default',
  'multi/cursor/grok-4.7',
  'multi/cursor/composer-2.5',
  'multi/cursor/composer-2.5/effort=high',
  'multi/antigravity/gemini-3.1-pro[1m]',
  'multi/antigravity/gemini-3.8-flash[1m]',
  'multi/antigravity/claude-sonnet-4-6',
  'multi/antigravity/claude-sonnet-4-6-high',
  'multi/zen/deepseek-v4-pro',
  'multi/zen/kimi-k3',
].map((model) => ({ model }));
const catalog = workerCatalog(rows);

test('a short id resolves to the full model its picker row spells', () => {
  assert.deepEqual(resolveWorker(catalog, 'multi-cursor', 'composer-2.5'), {
    type: 'multi-cursor',
    provider: 'cursor',
    label: 'Cursor',
    id: 'composer-2.5',
    model: 'multi/cursor/composer-2.5',
  });
  // The 1M context tag stays on the resolved model, as on the picker row.
  assert.equal(
    resolveWorker(catalog, 'multi-antigravity', 'gemini-3.8-flash').model,
    'multi/antigravity/gemini-3.8-flash[1m]',
  );
  assert.equal(
    resolveWorker(catalog, 'multi-openai', 'GPT-6-Luna').model,
    'multi/openai/gpt-6-luna',
  );
});

test('a full id resolves, with or without its context tag', () => {
  for (const spelling of ['multi/zen/kimi-k3', ' multi/zen/kimi-k3 ']) {
    assert.equal(resolveWorker(catalog, 'multi-zen', spelling).model, 'multi/zen/kimi-k3');
  }
  for (const spelling of [
    'multi/antigravity/gemini-3.1-pro',
    'multi/antigravity/gemini-3.1-pro[1m]',
  ]) {
    assert.equal(
      resolveWorker(catalog, 'multi-antigravity', spelling).model,
      'multi/antigravity/gemini-3.1-pro[1m]',
    );
  }
});

test('another provider’s model is refused, naming this provider’s models and the right type', () => {
  assert.throws(
    () => resolveWorker(catalog, 'multi-cursor', 'multi/zen/kimi-k3'),
    (error: Error) =>
      error.message.includes('multi-cursor runs Cursor models only') &&
      error.message.includes('multi/zen/kimi-k3 belongs to Zen. Use multi-zen for it.') &&
      error.message.includes('Cursor models: default, grok-4.7, composer-2.5.'),
  );
  assert.throws(
    () => resolveWorker(catalog, 'multi-cursor', 'kimi-k3'),
    /multi-cursor has no model "kimi-k3"\. "kimi-k3" belongs to multi-zen\. Cursor models: default, grok-4\.7, composer-2\.5\. Omit model for the default, default\./,
  );
  assert.throws(
    () => resolveWorker(catalog, 'multi-openai', 'sonnet'),
    /does not run Claude models; "sonnet" is a Claude alias\. OpenAI models: gpt-6-astra, gpt-6-luna\./,
  );
  assert.throws(
    () => resolveWorker(catalog, 'multi-antigravity', 'gemini-9-ultra'),
    /multi-antigravity has no model "gemini-9-ultra"\. Antigravity models: gemini-3\.1-pro, gemini-3\.8-flash, claude-sonnet-4-6\./,
  );
  assert.throws(() => resolveWorker(catalog, 'multi-grok'), /Unknown Multi worker multi-grok/);
});

test('no model runs the provider default: the newest or native default, not the first row', () => {
  assert.equal(resolveWorker(catalog, 'multi-openai').id, 'gpt-6-astra');
  assert.equal(resolveWorker(catalog, 'multi-cursor', '').id, 'default');
  assert.equal(resolveWorker(catalog, 'multi-antigravity').id, 'gemini-3.8-flash');
  assert.equal(resolveWorker(catalog, 'multi-zen').id, 'deepseek-v4-pro');
  // A default the session does not show falls back to its first row.
  const narrowed = workerCatalog([{ model: 'multi/openai/gpt-6-luna' }]);
  assert.equal(resolveWorker(narrowed, 'multi-openai').id, 'gpt-6-luna');
  assert.equal(
    antigravityDefaultWorkerModel([
      'claude-opus',
      'gemini-3.8-flash',
      'gemini-3.8-pro',
      'gemini-3.1-pro',
    ]),
    'gemini-3.8-pro',
  );
  assert.equal(antigravityDefaultWorkerModel(['claude-opus']), undefined);
});

test('effort is a separate provider-wide field, never a model name', () => {
  assert.equal(resolveWorker(catalog, 'multi-openai', 'gpt-6-luna').effort, 'medium');
  assert.equal(resolveWorker(catalog, 'multi-zen', 'kimi-k3').effort, 'medium');
  assert.equal(resolveWorker(catalog, 'multi-cursor', 'composer-2.5').effort, undefined);
  assert.throws(
    () => resolveWorker(catalog, 'multi-openai', 'gpt-6-luna-high'),
    /Effort is not part of a model name: pass model "gpt-6-luna"\./,
  );
  // A preset row and a native effort variant are not worker models.
  assert.throws(
    () => resolveWorker(catalog, 'multi-cursor', 'composer-2.5/effort=high'),
    /no model/,
  );
  assert.throws(
    () => resolveWorker(catalog, 'multi-antigravity', 'claude-sonnet-4-6-high'),
    /Effort is not part of a model name: pass model "claude-sonnet-4-6"\./,
  );
  const agents = workerDefinitions(catalog);
  assert.equal(agents['multi-openai'].effort, 'medium');
  assert.equal(agents['multi-antigravity'].effort, undefined);
  assert(Object.keys(agents).every((type) => /^multi-[a-z]+$/.test(type)));
});

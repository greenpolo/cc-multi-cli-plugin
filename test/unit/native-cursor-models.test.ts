import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cursorModelOptions,
  cursorPickerOptions,
  cursorSelection,
} from '../../plugins/multi-cursor/src/models.ts';

const options = cursorModelOptions([
  {
    id: 'test-model',
    displayName: 'Test Model',
    parameters: [{ id: 'effort', values: [{ value: 'low' }, { value: 'high' }] }],
    variants: [{ params: [{ id: 'effort', value: 'low' }], displayName: 'Low', isDefault: true }],
  },
]);

test('Cursor catalog preserves actual IDs and presets; effort never silently substitutes', () => {
  assert.equal(options[0].worker, 'cursor-test-model');
  assert.equal(options[0].description, 'Test Model via Cursor · low effort');
  assert.deepEqual(cursorSelection(options[0], 'high'), {
    id: 'test-model',
    params: [{ id: 'effort', value: 'high' }],
  });
  assert.throws(() => cursorSelection(options[0], 'ultracode'), /supports effort/);
  assert.equal(cursorSelection(options[1], 'high').params?.[0].value, 'low');
  assert.deepEqual(cursorModelOptions([{ id: 'auto-smart', displayName: 'Router' }]), []);
});

test('Cursor base routes explicitly disable Fast even when the account defaults to it', () => {
  const catalog = cursorModelOptions([
    {
      id: 'composer-2.5',
      displayName: 'Composer 2.5',
      variants: [
        { displayName: 'Fast', isDefault: true, params: [{ id: 'fast', value: 'true' }] },
        { displayName: 'Standard', params: [{ id: 'fast', value: 'false' }] },
      ],
    },
  ]);
  const base = catalog.find((option) => option.model === 'multi/cursor/composer-2.5');
  assert(base);
  assert.deepEqual(base.selection.params, [{ id: 'fast', value: 'false' }]);
  assert.equal(base.worker, 'cursor-composer-2-5');
  assert.deepEqual(cursorSelection(base).params, [{ id: 'fast', value: 'false' }]);
  assert.deepEqual(cursorPickerOptions(catalog)[0].selection, base.selection);
  assert.throws(
    () =>
      cursorModelOptions([
        {
          id: 'fast-only',
          displayName: 'Fast only',
          variants: [
            { displayName: 'Fast', isDefault: true, params: [{ id: 'fast', value: 'true' }] },
          ],
        },
      ]),
    /no advertised non-Fast/,
  );
});

test('catalog cross-products stay selectable without multiplying named workers', () => {
  const catalog = cursorModelOptions([
    {
      id: 'composer-test',
      displayName: 'Composer',
      variants: [
        {
          displayName: 'Default',
          isDefault: true,
          params: [
            { id: 'effort', value: 'low' },
            { id: 'fast', value: 'false' },
          ],
        },
        {
          displayName: 'High',
          params: [
            { id: 'effort', value: 'high' },
            { id: 'fast', value: 'false' },
          ],
        },
        {
          displayName: 'High Fast',
          params: [
            { id: 'effort', value: 'high' },
            { id: 'fast', value: 'true' },
          ],
        },
      ],
    },
  ]);
  assert.equal(catalog.length, 4);
  assert.deepEqual(
    catalog.filter((o) => o.nativeWorker).map((o) => o.worker),
    ['cursor-composer-test', 'cursor-composer-test-effort-high'],
  );
  assert(catalog.some((o) => o.model.includes('fast=true')));
});

test('Cursor picker defaults to Auto, Grok and Composer, excluding other providers and presets', () => {
  const ids = [
    'gemini-3.8-flash',
    'composer-2',
    'claude-fable-5-1',
    'default',
    'gpt-5.6-sol',
    'grok-4.7',
    'grok-4.6',
    'composer-2.5',
  ];
  const catalog = cursorModelOptions(
    ids.map((id) => ({
      id,
      displayName: id === 'default' ? 'Auto' : id,
      variants:
        id === 'default'
          ? [{ displayName: 'Auto', isDefault: true, params: [] }]
          : [
              {
                displayName: 'Default',
                isDefault: true,
                params: [{ id: 'fast', value: 'false' }],
              },
              { displayName: 'Fast', params: [{ id: 'fast', value: 'true' }] },
            ],
    })),
  );
  const before = structuredClone(catalog);
  const picker = cursorPickerOptions(catalog);
  assert.deepEqual(
    picker.map((o) => o.selection.id),
    ['default', 'grok-4.7', 'composer-2.5'],
  );
  assert.equal(picker[0].label, 'Auto via Cursor');
  assert.deepEqual(picker[0].selection, { id: 'default' });
  assert.equal(picker[0].worker, 'cursor-default');
  assert.equal(picker[0].nativeWorker, true);
  assert(picker.every((o) => o.model.split('/').length === 3));
  assert.deepEqual(
    catalog,
    before,
    'Picker filtering must not remove full model routes or workers',
  );
  assert.deepEqual(
    cursorPickerOptions(catalog.filter((o) => o.selection.id === 'composer-2.5')).map(
      (o) => o.selection.id,
    ),
    ['composer-2.5'],
  );
  assert.deepEqual(cursorPickerOptions([]), []);
});

test('Cursor extras expose only a base effort row while preserving parameters and explicit workers', () => {
  const catalog = cursorModelOptions([
    {
      id: 'extra',
      displayName: 'Extra',
      parameters: [{ id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }] }],
      variants: [
        {
          displayName: 'Low',
          isDefault: true,
          params: [
            { id: 'reasoning_effort', value: 'low' },
            { id: 'fast', value: 'false' },
            { id: 'context', value: 'large' },
          ],
        },
        {
          displayName: 'High',
          params: [
            { id: 'reasoning_effort', value: 'high' },
            { id: 'fast', value: 'false' },
            { id: 'context', value: 'large' },
          ],
        },
      ],
    },
  ]);
  const picker = cursorPickerOptions(catalog, 'extra,extra');
  assert.equal(picker.length, 1);
  assert.equal(picker[0].model, 'multi/cursor/extra');
  assert.deepEqual(cursorSelection(picker[0], 'high').params, [
    { id: 'context', value: 'large' },
    { id: 'fast', value: 'false' },
    { id: 'reasoning_effort', value: 'high' },
  ]);
  const explicit = catalog.find(({ worker }) => worker === 'cursor-extra-reasoning-effort-high');
  assert(explicit?.nativeWorker);
  assert.equal(cursorSelection(explicit, 'low').params?.[0].value, 'high');
});

test('extra Cursor picker models are opt-in, deduplicated and checked against the account catalog', () => {
  const catalog = cursorModelOptions(
    ['default', 'grok-4.7', 'composer-2.5', 'gemini-3.8-flash', 'gpt-5.6-sol'].map((id) => ({
      id,
      displayName: id,
    })),
  );
  const before = structuredClone(catalog);
  assert.deepEqual(
    cursorPickerOptions(catalog, ' gemini-3.8-flash, gpt-5.6-sol,gemini-3.8-flash,grok-4.7, ').map(
      (o) => o.selection.id,
    ),
    ['default', 'grok-4.7', 'composer-2.5', 'gemini-3.8-flash', 'gpt-5.6-sol'],
  );
  assert.deepEqual(cursorPickerOptions(catalog, ' , '), cursorPickerOptions(catalog));
  assert.throws(
    () => cursorPickerOptions(catalog, 'missing-model'),
    /MULTI_CURSOR_EXTRA_MODELS.*missing-model.*--cursor-models/,
  );
  assert.deepEqual(catalog, before);
});

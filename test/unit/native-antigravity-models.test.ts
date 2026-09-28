import assert from 'node:assert/strict';
import test from 'node:test';
import {
  antigravityPickerOptions,
  discoverAntigravityModels,
  parseAntigravityModels,
  selectAntigravityModel,
} from '../../plugins/multi-antigravity/src/models.ts';

test('Antigravity catalog resolves only advertised effort variants', () => {
  const models = parseAntigravityModels(
    'Fetching available models...\ngemini-3.8-flash-low\tGemini Low\ngemini-3.8-flash-high\tGemini High\nclaude-sonnet-4-6\tSonnet\n',
  );
  assert.equal(models.length, 3);
  assert.equal(selectAntigravityModel(models, models[0].model, 'high').id, 'gemini-3.8-flash-high');
  assert.equal(selectAntigravityModel(models, models[2].model).id, 'claude-sonnet-4-6');
  assert.throws(() => selectAntigravityModel(models, models[0].model, 'medium'), /advertise/);
  assert.deepEqual(selectAntigravityModel(models, models[2].model, 'high'), {
    ...models[2],
    effort: 'high',
  });
  assert.throws(() => selectAntigravityModel(models, 'multi/antigravity/unknown'), /Unknown/);
  assert.throws(() => parseAntigravityModels('not a catalog'), /no recognized/);
});

test('Antigravity selection ignores the 1M-context picker tag', () => {
  const models = parseAntigravityModels(
    'gemini-3.8-flash-low\tGemini Low\ngemini-3.8-flash-high\tGemini High\nclaude-sonnet-4-6\tSonnet\n',
  );
  assert.equal(selectAntigravityModel(models, `${models[2].model}[1m]`).id, 'claude-sonnet-4-6');
  assert.equal(
    selectAntigravityModel(models, 'multi/antigravity/gemini-3.8-flash[1m]', 'high').id,
    'gemini-3.8-flash-high',
  );
  assert.throws(() => selectAntigravityModel(models, 'multi/antigravity/unknown[1m]'), /Unknown/);
});

test('Antigravity picker groups exact suffix families and resolves only advertised defaults', () => {
  const models = parseAntigravityModels(
    [
      'gemini-low\tGemini (Low)',
      'gemini-high\tGemini (High)',
      'gemini-medium\tGemini (Medium)',
      'sonnet\tSonnet',
      'sonnet-thinking\tSonnet Thinking',
      'single-low\tSingle Low',
    ].join('\n'),
  );
  const before = structuredClone(models);
  const picker = antigravityPickerOptions(models);
  assert.deepEqual(
    picker.map(({ id }) => id),
    ['gemini', 'sonnet', 'sonnet-thinking', 'single'],
  );
  assert.equal(picker[0].label, 'Antigravity · Gemini');
  assert.equal(selectAntigravityModel(models, picker[0].model).id, 'gemini-medium');
  for (const effort of ['low', 'medium', 'high']) {
    assert.equal(selectAntigravityModel(models, picker[0].model, effort).id, `gemini-${effort}`);
  }
  assert.equal(
    selectAntigravityModel(
      models.filter(({ id }) => id !== 'gemini-medium'),
      picker[0].model,
    ).id,
    'gemini-high',
  );
  assert.equal(selectAntigravityModel(models, picker[3].model).id, 'single-low');
  assert.throws(
    () => selectAntigravityModel(models, picker[3].model, 'high'),
    /does not advertise/,
  );
  assert.throws(
    () => selectAntigravityModel(models, picker[0].model, 'max'),
    /advertised low, medium or high/,
  );
  assert.equal(selectAntigravityModel(models, models[0].model).id, 'gemini-low');
  assert.deepEqual(models, before);
});

test('Antigravity never shadows a native base or collapses thinking identities by label', () => {
  const models = parseAntigravityModels(
    'gemini\tGemini\ngemini-high\tGemini High\nsonnet-thinking-low\tSonnet Low\nsonnet-low\tSonnet Low',
  );
  assert.deepEqual(
    antigravityPickerOptions(models).map(({ id }) => id),
    ['gemini', 'gemini-high', 'sonnet-thinking', 'sonnet'],
  );
  assert.deepEqual(selectAntigravityModel(models, 'multi/antigravity/gemini', 'low'), {
    ...models[0],
    effort: 'low',
  });
});

test('discovers Windows npm shims with injected platform and process execution', async () => {
  let receivedCommand = '';
  let receivedArgs: readonly string[] = [];
  let receivedOptions: Record<string, unknown> = {};
  const fakeExecFile = ((
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
    callback: (error: null, result: { stdout: string; stderr: string }) => void,
  ) => {
    receivedCommand = command;
    receivedArgs = args;
    receivedOptions = options;
    callback(null, { stdout: 'gemini-low\tGemini Low\n', stderr: '' });
  }) as unknown as typeof import('node:child_process').execFile;

  const models = await discoverAntigravityModels({
    platform: 'win32',
    env: { PATH: 'C:\\tools', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    exists: (filename) => filename === 'C:\\tools\\agy.cmd',
    execFile: fakeExecFile,
  });

  assert.equal(receivedCommand, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(receivedArgs, ['/d', '/s', '/c', '"C:\\tools\\agy.cmd models"']);
  assert.equal(receivedOptions.windowsVerbatimArguments, true);
  assert.deepEqual(
    models.map(({ id }) => id),
    ['gemini-low'],
  );
});

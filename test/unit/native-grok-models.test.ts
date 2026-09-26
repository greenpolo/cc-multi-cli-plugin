import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverGrokModels,
  type GrokModel,
  type GrokSelection,
  grokPickerOptions,
  parseGrokModels,
  selectGrokModel,
} from '../../plugins/multi-grok/src/models.ts';

/** Recorded from `grok models` on 1.0.35, including its unauthenticated notice. */
const catalog = [
  'You are not authenticated.',
  '',
  'Default model: grok-4.6',
  '',
  'Available models:',
  '  * grok-4.6 (default)',
  '  - grok-4.5',
  '',
].join('\n');

test('parses the advertised Grok catalog and ignores its prose', () => {
  const models: GrokModel[] = parseGrokModels(catalog);
  assert.deepEqual(models, [
    {
      id: 'grok-4.6',
      model: 'multi/grok/grok-4.6',
      label: 'Grok 4.6',
      default: true,
    },
    {
      id: 'grok-4.5',
      model: 'multi/grok/grok-4.5',
      label: 'Grok 4.5',
      default: false,
    },
  ]);
  assert.throws(() => parseGrokModels('Default model: grok-4.6\n'), /no recognized/);
  assert.throws(() => parseGrokModels(''), /no recognized/);
});

test('picker shows the account default first and rejects unknown selections', () => {
  const models = parseGrokModels(['  - grok-4.5', '  * grok-4.6 (default)'].join('\n'));
  assert.deepEqual(
    grokPickerOptions(models).map(({ id }) => id),
    ['grok-4.6', 'grok-4.5'],
  );
  assert.deepEqual(
    grokPickerOptions(models, ' grok-4.5 , grok-4.5').map(({ id }) => id),
    ['grok-4.5'],
  );
  assert.deepEqual(grokPickerOptions(models, ''), []);
  assert.throws(() => grokPickerOptions(models, 'grok-9'), /unknown Grok model: grok-9/);
});

test('selection resolves routes and admits only Claude effort levels', () => {
  const models = parseGrokModels(catalog);
  const selection: GrokSelection = selectGrokModel(models, 'multi/grok/grok-4.6');
  assert.equal(selection.model.id, 'grok-4.6');
  assert.equal(selection.effort, undefined);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(selectGrokModel(models, 'multi/grok/grok-4.5', effort).effort, effort);
  }
  // The CLI also accepts none and minimal; Claude has no row for them.
  assert.throws(() => selectGrokModel(models, 'multi/grok/grok-4.6', 'none'), /does not support/);
  assert.throws(() => selectGrokModel(models, 'multi/grok/grok-4.6', 7), /does not support/);
  assert.throws(() => selectGrokModel(models, 'multi/grok/grok-9'), /Unknown Grok model/);
  assert.throws(() => selectGrokModel(models, undefined), /Unknown Grok model/);
});

test('discovers the catalog through a Windows shim without colored output', async () => {
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
    callback(null, { stdout: catalog, stderr: '' });
  }) as unknown as typeof import('node:child_process').execFile;

  const models = await discoverGrokModels({
    platform: 'win32',
    env: { PATH: 'C:\\tools', ComSpec: 'C:\\Windows\\System32\\cmd.exe', XAI_API_KEY: 'xai-key' },
    exists: (filename) => filename === 'C:\\tools\\grok.cmd',
    execFile: fakeExecFile,
  });

  assert.equal(receivedCommand, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(receivedArgs, ['/d', '/s', '/c', '"C:\\tools\\grok.cmd models"']);
  assert.equal(receivedOptions.windowsVerbatimArguments, true);
  const environment = receivedOptions.env as NodeJS.ProcessEnv;
  assert.equal(environment.NO_COLOR, '1');
  assert.equal(environment.XAI_API_KEY, undefined);
  assert.deepEqual(
    models.map(({ id }) => id),
    ['grok-4.6', 'grok-4.5'],
  );
});

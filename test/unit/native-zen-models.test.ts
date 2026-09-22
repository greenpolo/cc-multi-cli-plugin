import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  readZenKey,
  saveZenKey,
  validateZenKey,
  ZenAuthError,
  zenAuthFile,
} from '../../plugins/multi-zen/src/auth.ts';
import {
  ZEN_MODELS,
  ZEN_WORKERS,
  zenModelOptions,
  zenPickerOptions,
} from '../../plugins/multi-zen/src/models.ts';
import { removeTemporary } from '../temporary.ts';

function hostAuthOptions(dataHome: string) {
  const env: NodeJS.ProcessEnv = { OPENCODE_API_KEY: undefined };
  if (process.platform === 'win32') {
    env.LOCALAPPDATA = dataHome;
  } else {
    env.XDG_DATA_HOME = dataHome;
  }
  return { platform: process.platform, env };
}

async function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('Zen auth resolves Unix and Windows OpenCode data roots with explicit overrides', () => {
  assert.equal(
    zenAuthFile({ platform: 'linux', homedir: '/home/test', env: {} }),
    '/home/test/.local/share/opencode/auth.json',
  );
  assert.equal(
    zenAuthFile({
      platform: 'darwin',
      homedir: '/Users/test',
      env: { XDG_DATA_HOME: '/custom/data' },
    }),
    '/custom/data/opencode/auth.json',
  );
  assert.equal(
    zenAuthFile({
      platform: 'win32',
      homedir: 'C:\\Users\\test',
      env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    }),
    'C:\\Users\\test\\AppData\\Local\\opencode\\auth.json',
  );
  assert.equal(
    zenAuthFile({
      platform: 'win32',
      homedir: 'C:\\Users\\test',
      env: { OPENCODE_AUTH_FILE: 'D:\\auth.json' },
    }),
    'D:\\auth.json',
  );
});

test('Zen auth prefers an explicit API key without exposing its value', async () => {
  await withEnvironment(
    { OPENCODE_API_KEY: 'fixture-key', XDG_DATA_HOME: '/missing' },
    async () => {
      assert.equal(await readZenKey(), 'fixture-key');
    },
  );
});

test('Zen key validation rejects whitespace, controls, and non-ASCII without echoing input', async () => {
  for (const value of ['', 'fixture key', 'fixture\nkey', 'fixture\tkey', 'clé']) {
    assert.throws(
      () => validateZenKey(value),
      (error: unknown) => error instanceof ZenAuthError,
    );
  }
  assert.throws(
    () => validateZenKey('fixture\nSECRET_INVALID_KEY'),
    (error: unknown) =>
      error instanceof ZenAuthError && !error.message.includes('SECRET_INVALID_KEY'),
  );
  assert.equal(validateZenKey('visible-ASCII_fixture.key'), 'visible-ASCII_fixture.key');
});

test('an explicit Zen env key prevents reading saved auth', async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'zen-auth-test-'));
  t.after(() => removeTemporary(dataHome));
  const directory = path.join(dataHome, 'opencode');
  await mkdir(directory);
  await writeFile(path.join(directory, 'auth.json'), '{malformed');
  await withEnvironment(
    { OPENCODE_API_KEY: 'env-fixture-key', XDG_DATA_HOME: dataHome },
    async () => {
      assert.equal(await readZenKey(), 'env-fixture-key');
    },
  );
});

test('Zen auth reads only the official OpenCode API entry', async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'zen-auth-test-'));
  t.after(() => removeTemporary(dataHome));
  const directory = path.join(dataHome, 'opencode');
  await mkdir(directory);
  await writeFile(
    path.join(directory, 'auth.json'),
    JSON.stringify({ opencode: { type: 'api', key: 'saved-fixture-key' } }),
  );
  const options = hostAuthOptions(dataHome);
  await withEnvironment(options.env, async () => {
    assert.equal(await readZenKey(options), 'saved-fixture-key');
  });
});

test('Zen auth treats missing credentials as optional and rejects malformed explicit config', async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'zen-auth-test-'));
  t.after(() => removeTemporary(dataHome));
  const options = hostAuthOptions(dataHome);
  await withEnvironment(options.env, async () => {
    const environmentOptions = { platform: options.platform, env: process.env };
    assert.equal(await readZenKey(environmentOptions), undefined);
    for (const value of [' ', 'fixture key', 'fixture\nkey']) {
      process.env.OPENCODE_API_KEY = value;
      await assert.rejects(readZenKey(environmentOptions), (error: unknown) => {
        assert(error instanceof ZenAuthError);
        return true;
      });
    }
  });
});

test('Zen auth rejects malformed saved credentials without including secrets', async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'zen-auth-test-'));
  t.after(() => removeTemporary(dataHome));
  const directory = path.join(dataHome, 'opencode');
  await mkdir(directory);
  await writeFile(path.join(directory, 'auth.json'), '{"opencode":{"type":"api"}}');
  const options = hostAuthOptions(dataHome);
  await withEnvironment(options.env, async () => {
    await assert.rejects(
      readZenKey(options),
      (error: unknown) => error instanceof ZenAuthError && !error.message.includes('SECRET'),
    );
  });
});

test('Zen catalog exposes bounded protocols and only supported effort workers', () => {
  assert.deepEqual(
    ZEN_MODELS.map((model) => [model.id, model.protocol]),
    [
      ['gpt-6-luna', 'responses'],
      ['gpt-6-sol', 'responses'],
      ['gpt-5.6-luna', 'responses'],
      ['gpt-5.6-terra', 'responses'],
      ['gpt-5.6-sol', 'responses'],
      ['kimi-k2.7-code', 'chat'],
      ['glm-5.2', 'chat'],
      ['minimax-m2.7', 'chat'],
      ['big-pickle', 'chat'],
      ['mimo-v2.5-free', 'chat'],
      ['ling-3.0-flash-fin-free', 'chat'],
      ['nemotron-3-ultra-free', 'chat'],
      ['nemotron-3.5-lightning-free', 'chat'],
      ['muse-spark-1.3-contributor-free', 'responses'],
      ['muse-spark-1.2-contributor-free', 'responses'],
      ['deepseek-v4-pro', 'chat'],
      ['deepseek-v4-flash', 'chat'],
      ['kimi-k3', 'chat'],
      ['glm-5.3', 'chat'],
      ['glm-5.3-flash', 'chat'],
      ['muse-spark-1.3', 'responses'],
    ],
  );
  assert.equal(zenModelOptions(['big-pickle'])[0].model, 'multi/zen/big-pickle');
  assert.equal(ZEN_WORKERS['zen-big-pickle'].effort, undefined);
  assert.equal(ZEN_WORKERS['zen-gpt-5.6-luna'].effort, 'medium');
  assert.equal(ZEN_WORKERS['zen-gpt-5.6-luna-high'].effort, 'high');
  assert.equal(ZEN_WORKERS['zen-gpt-5.6-luna-impossible'], undefined);
});

test('Zen picker allowlist preserves order and validates model IDs', () => {
  assert.deepEqual(
    zenPickerOptions(undefined).map((model) => model.id),
    [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'kimi-k3',
      'glm-5.3',
      'glm-5.3-flash',
      'muse-spark-1.3',
    ],
  );
  assert.deepEqual(zenPickerOptions(''), []);
  assert.deepEqual(
    zenPickerOptions(' mimo-v2.5-free, big-pickle,mimo-v2.5-free ').map((model) => model.id),
    ['mimo-v2.5-free', 'big-pickle'],
  );
  assert.throws(() => zenPickerOptions('typo'), /MULTI_ZEN_MODELS: unknown Zen model/);
});

test('Zen local key entry preserves other accounts and writes a private auth file', async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'zen-connect-test-'));
  t.after(() => removeTemporary(dataHome));
  const directory = path.join(dataHome, 'opencode');
  await mkdir(directory);
  const file = path.join(directory, 'auth.json');
  await writeFile(file, JSON.stringify({ other: { type: 'api', key: 'other-fixture' } }));
  const options = hostAuthOptions(dataHome);
  await withEnvironment(options.env, async () => {
    await saveZenKey('new-fixture', options);
    assert.equal(await readZenKey(options), 'new-fixture');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).other.key, 'other-fixture');
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    await writeFile(file, 'invalid-json');
    await assert.rejects(saveZenKey('next-fixture', options), /preserved/);
    assert.equal(await readFile(file, 'utf8'), 'invalid-json');
  });
});

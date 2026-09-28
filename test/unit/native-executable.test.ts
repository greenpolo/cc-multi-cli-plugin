import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executableInvocation,
  resolveExecutable,
} from '../../plugins/multi-core/src/gateway/executable.ts';

test('resolves Windows npm shims using PATHEXT order', () => {
  const seen: string[] = [];
  const executable = resolveExecutable('agy', {
    platform: 'win32',
    env: { PATH: 'C:\\tools;C:\\other', PATHEXT: '.EXE;.CMD' },
    exists: (filename) => {
      seen.push(filename);
      return filename === 'C:\\other\\agy.cmd';
    },
  });
  assert.equal(executable, 'C:\\other\\agy.cmd');
  assert.deepEqual(seen, [
    'C:\\tools\\agy.exe',
    'C:\\tools\\agy.cmd',
    'C:\\tools\\agy',
    'C:\\other\\agy.exe',
    'C:\\other\\agy.cmd',
  ]);
});

test('uses standard Windows executable extensions when PATHEXT is absent', () => {
  assert.equal(
    resolveExecutable('agy', {
      platform: 'win32',
      env: { PATH: 'C:\\tools' },
      exists: (filename) => filename === 'C:\\tools\\agy.cmd',
    }),
    'C:\\tools\\agy.cmd',
  );
});

test('honors explicit executable paths and fails clearly when absent', () => {
  assert.equal(
    resolveExecutable('claude', {
      platform: 'win32',
      configuredPath: 'D:\\Apps\\claude.exe',
      exists: (filename) => filename.endsWith('claude.exe'),
    }),
    'D:\\Apps\\claude.exe',
  );
  assert.throws(
    () => resolveExecutable('claude', { env: { PATH: '' }, exists: () => false }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT' &&
      /Executable not found on PATH: claude/.test(error.message),
  );
});

test('keeps empty arguments when invoking cmd shims through ComSpec', () => {
  assert.deepEqual(
    executableInvocation(
      'C:\\npm\\claude.cmd',
      ['--setting-sources', '', 'plugin', 'list'],
      'win32',
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      { readShim: () => 'unexpected shim body' },
    ).args,
    ['/d', '/s', '/c', '"C:\\npm\\claude.cmd --setting-sources "" plugin list"'],
  );
});

test('invokes cmd shims through ComSpec without shell mode', () => {
  assert.deepEqual(
    executableInvocation(
      'C:\\Program Files\\agy.cmd',
      ['--prompt', 'hello world'],
      'win32',
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      { readShim: () => 'unexpected shim body' },
    ),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', `""C:\\Program Files\\agy.cmd" --prompt "hello world""`],
      viaComSpec: true,
      options: { windowsVerbatimArguments: true },
    },
  );
});

test('invokes a canonical npm cmd shim with Node directly', () => {
  const shim = '"%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js" %*';
  const target = 'C:\\Program Files\\node_modules\\pkg\\cli.js';
  const seen: string[] = [];
  const invocation = executableInvocation(
    'C:\\Program Files\\agy.cmd',
    ['--agents', '{"agy":{}}'],
    'win32',
    {},
    {
      readShim: () => shim,
      exists: (filename) => {
        seen.push(filename);
        return filename === target;
      },
    },
  );
  assert.deepEqual(invocation, {
    command: process.execPath,
    args: [target, '--agents', '{"agy":{}}'],
    viaComSpec: false,
  });
  assert.deepEqual(seen, [target]);
});

test('resolves npm layouts in bat shims', () => {
  const target = 'C:\\tools\\node_modules\\claude\\cli.mjs';
  assert.deepEqual(
    executableInvocation(
      'C:\\tools\\claude.bat',
      ['--version'],
      'win32',
      {},
      {
        readShim: () => 'node  "%dp0%\\node_modules\\claude\\cli.mjs" %*',
        exists: (filename) => filename === target,
      },
    ),
    { command: process.execPath, args: [target, '--version'], viaComSpec: false },
  );
});

test('falls back when an npm shim target is missing', () => {
  assert.equal(
    executableInvocation(
      'C:\\tools\\claude.bat',
      ['--version'],
      'win32',
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      {
        readShim: () => 'node  "%dp0%\\node_modules\\claude\\cli.mjs" %*',
        exists: () => false,
      },
    ).viaComSpec,
    true,
  );
});

test('leaves non-shim executables untouched', () => {
  assert.deepEqual(executableInvocation('C:\\tools\\claude.exe', ['--version'], 'win32'), {
    command: 'C:\\tools\\claude.exe',
    args: ['--version'],
    viaComSpec: false,
  });
});

test('Windows resolution reads Path and PathExt regardless of spelling', () => {
  const found = resolveExecutable('claude', {
    platform: 'win32',
    env: { Path: 'C:\\bin', PathExt: '.CMD' },
    exists: (candidate) => candidate === 'C:\\bin\\claude.cmd',
  });
  assert.equal(found, 'C:\\bin\\claude.cmd');
});

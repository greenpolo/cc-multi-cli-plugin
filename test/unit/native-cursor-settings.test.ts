import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { antigravityPermissionPolicy } from '../../plugins/multi-antigravity/src/permissions.ts';
import {
  checkHarnessSettings,
  type HarnessSettingsOptions,
  policyCommandTimeoutMs,
  systemCommandPath,
} from '../../plugins/multi-core/src/gateway/harness-settings.ts';
import type { PermissionContext } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { sharedAdmission } from '../../plugins/multi-core/src/launcher.ts';
import {
  cursorPermissionPolicy,
  TOOL_CAPABILITIES,
} from '../../plugins/multi-cursor/src/permissions.ts';
import { grokPermissionPolicy } from '../../plugins/multi-grok/src/permissions.ts';
import { removeTemporary } from '../temporary.ts';

const absentManagedPolicy = async (): Promise<string> => '';

async function checkSettings(
  cwd: string,
  args: readonly string[],
  inlineSettings: Record<string, unknown>,
  options: HarnessSettingsOptions = {},
) {
  return checkHarnessSettings(cwd, args, inlineSettings, {
    platform: 'linux',
    osRelease: 'test-linux',
    runCommand: absentManagedPolicy,
    ...options,
  });
}

let inventory: unknown[] = [];
test.beforeEach(() => {
  mock.restoreAll();
  inventory = [];
  mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      callback(null, JSON.stringify(inventory), '');
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cursor-settings-'));
}

test('native settings admission respects source selection and rechecks changed ancestor policies', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-settings-'));
  t.after(() => removeTemporary(root));
  const config = path.join(root, 'user');
  const cwd = path.join(root, 'project', 'nested');
  await fs.mkdir(config);
  await fs.mkdir(cwd, { recursive: true });
  t.mock.property(process, 'env', { ...process.env, CLAUDE_CONFIG_DIR: config });
  await fs.writeFile(
    path.join(config, 'settings.json'),
    JSON.stringify({ permissions: { ask: ['Bash'] } }),
  );
  await assert.rejects(checkSettings(cwd, [], {}), /permissions.ask/);
  await checkSettings(cwd, ['--setting-sources=project,local'], {});
  const project = path.join(root, 'project', '.claude');
  await fs.mkdir(project);
  await fs.writeFile(
    path.join(project, 'settings.local.json'),
    JSON.stringify({ permissions: { deny: ['Read'] } }),
  );
  assert.deepEqual((await checkSettings(cwd, ['--setting-sources', 'local'], {})).disallowedTools, [
    'Read',
  ]);
  await checkSettings(cwd, ['--setting-sources', 'project'], {});
  await fs.writeFile(path.join(project, 'settings.json'), '{invalid');
  await assert.rejects(checkSettings(cwd, ['--setting-sources=project'], {}), /admission failed/);
  await checkSettings(cwd, ['--setting-sources='], {});
});

test('settings admission validates with the requested harness policy', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'user');
  await fs.mkdir(config);
  t.mock.property(process, 'env', { ...process.env, CLAUDE_CONFIG_DIR: config });
  // Claude tools Cursor cannot enforce but Antigravity maps to native tools.
  await fs.writeFile(
    path.join(config, 'settings.json'),
    JSON.stringify({ permissions: { deny: ['WebSearch', 'WebFetch'] } }),
  );
  await assert.rejects(checkSettings(root, [], {}), /WebSearch; unsupported policy/);

  const validated: PermissionContext[] = [];
  const admitted = await checkSettings(
    root,
    [],
    {},
    { validate: (context) => void validated.push(context) },
  );
  assert.deepEqual(admitted.disallowedTools, ['WebSearch', 'WebFetch']);
  assert.deepEqual(validated.at(-1)?.disallowedTools, ['WebSearch', 'WebFetch']);

  // The per-file Cursor check is an option of its own, not an inference from which function
  // `validate` happens to be: a wrapper around Antigravity's policy must not silently change it.
  const wrapped = (context: PermissionContext) => antigravityPermissionPolicy(context);
  await assert.rejects(
    checkSettings(root, [], {}, { validate: wrapped, cursorToolRules: true }),
    /Native Cursor settings admission failed/,
  );
  assert.deepEqual((await checkSettings(root, [], {}, { validate: wrapped })).disallowedTools, [
    'WebSearch',
    'WebFetch',
  ]);

  // Structural admission still applies per file whichever harness validates the result.
  await fs.writeFile(
    path.join(config, 'settings.json'),
    JSON.stringify({ permissions: { deny: ['WebSearch'], ask: ['Bash'] } }),
  );
  await assert.rejects(
    checkSettings(root, [], {}, { validate: antigravityPermissionPolicy }),
    /permissions.ask/,
  );
});

test('Antigravity admits every Claude tool rule Cursor admits', () => {
  // sharedAdmission() hands the merged rules to Antigravity's validator when both harnesses
  // are present, which is only safe while this containment holds. It is maintained by hand
  // in two separate tool tables, so it is asserted rather than assumed.
  const cursorTools = [
    ...new Set(TOOL_CAPABILITIES.flatMap(([, names]) => [...names])),
    // Recognized outside the capability table: absent from Cursor either way, so a rule
    // naming one cannot grant anything.
    'Agent',
    'Task',
  ];
  for (const tool of cursorTools) {
    const context = { permissionMode: 'auto' as const, disallowedTools: [tool] };
    assert.doesNotThrow(() => cursorPermissionPolicy(context), `Cursor rejected ${tool}`);
    assert.doesNotThrow(() => antigravityPermissionPolicy(context), `Antigravity rejected ${tool}`);
  }
  // Containment is one-way, which is the whole reason the choice matters.
  const webFetch = { permissionMode: 'auto' as const, disallowedTools: ['WebFetch'] };
  assert.doesNotThrow(() => antigravityPermissionPolicy(webFetch));
  assert.throws(() => cursorPermissionPolicy(webFetch), /cannot enforce Claude tool rule WebFetch/);
});

test('Grok admits every Claude tool rule Cursor admits', () => {
  // sharedAdmission() also hands the merged rules to Grok's validator when Grok is the
  // native harness present, which is only safe while this containment holds too.
  const cursorTools = [
    ...new Set(TOOL_CAPABILITIES.flatMap(([, names]) => [...names])),
    'Agent',
    'Task',
  ];
  for (const tool of cursorTools) {
    const context = { permissionMode: 'auto' as const, disallowedTools: [tool] };
    assert.doesNotThrow(() => cursorPermissionPolicy(context), `Cursor rejected ${tool}`);
    assert.doesNotThrow(() => grokPermissionPolicy(context), `Grok rejected ${tool}`);
  }
  // Containment is one-way: Grok also enforces tools Cursor cannot express.
  const notebook = { permissionMode: 'auto' as const, disallowedTools: ['NotebookEdit'] };
  assert.doesNotThrow(() => grokPermissionPolicy(notebook));
  assert.throws(
    () => cursorPermissionPolicy(notebook),
    /cannot enforce Claude tool rule NotebookEdit/,
  );
});

test('the shared admission result is judged by the least restrictive native harness', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'user');
  await fs.mkdir(config);
  t.mock.property(process, 'env', { ...process.env, CLAUDE_CONFIG_DIR: config });
  await fs.writeFile(
    path.join(config, 'settings.json'),
    JSON.stringify({ permissions: { deny: ['WebFetch'] } }),
  );
  // One error is recorded for every native provider, so a launch that also has Cursor must
  // not refuse a rule Antigravity maps natively; Cursor rejects it on its own dispatch.
  assert.deepEqual(
    (await checkSettings(root, [], {}, sharedAdmission({ antigravity: true }))).disallowedTools,
    ['WebFetch'],
  );
  await assert.rejects(
    checkSettings(root, [], {}, sharedAdmission({})),
    /WebFetch; unsupported policy/,
  );
});

test('managed policy follows the requested harness policy', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runCommand = async () => '{"permissions":{"deny":["WebSearch"]}}';
  await assert.rejects(
    checkSettings(root, ['--setting-sources='], {}, { platform: 'darwin', runCommand }),
    /WebSearch; unsupported policy/,
  );
  const admitted = await checkSettings(
    root,
    ['--setting-sources='],
    {},
    { platform: 'darwin', runCommand, validate: antigravityPermissionPolicy },
  );
  assert.deepEqual(admitted.disallowedTools, ['WebSearch']);
});

test('native settings admission refuses CLI restrictions and caller hooks but accepts grants', async () => {
  const policy = await checkSettings(
    '/tmp',
    ['--setting-sources=', '--tools=Read,Bash', '--tools=Read,Edit', '--disallowedTools=Bash'],
    { permissions: { deny: ['Write'] } },
  );
  assert.deepEqual(policy.tools, ['Read']);
  assert.deepEqual(policy.disallowedTools, ['Bash', 'Write']);
  await assert.rejects(
    checkSettings(await temporaryDirectory(), ['--setting-sources=', '--tools=Bash(git:*)'], {}),
    /unsupported policy/,
  );
  for (const args of [['--setting-sources'], ['--setting-sources=managed']]) {
    await assert.rejects(checkSettings(await temporaryDirectory(), args, {}), /setting-sources/);
  }
  await checkSettings(
    await temporaryDirectory(),
    ['--setting-sources=', '--allowedTools', 'Bash'],
    {
      permissions: { allow: ['Bash'] },
    },
  );
  // Claude hooks never run for native tools, so they must not block admission.
  await checkSettings(await temporaryDirectory(), ['--setting-sources='], {
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'log' }] }] },
  });
});

test('native settings admission translates managed deny and refuses unknown controls', async (t) => {
  const original = fs.readFile;
  let policy = JSON.stringify({ permissions: { deny: ['Bash'] } });
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === '/etc/claude-code/managed-settings.json') {
      return policy;
    }
    return original(...args);
  });
  assert.deepEqual(
    (await checkSettings(await temporaryDirectory(), ['--setting-sources='], {})).disallowedTools,
    ['Bash'],
  );
  policy = JSON.stringify({ policyHelper: '/tmp/policy' });
  await assert.rejects(
    checkSettings(await temporaryDirectory(), ['--setting-sources='], {}),
    /cannot enforce managed policy/,
  );
});

test('native CLI tool policy accepts empty/default lists and variadic names', async () => {
  assert.deepEqual(
    (await checkSettings(await temporaryDirectory(), ['--setting-sources', '', '--tools', ''], {}))
      .tools,
    [],
  );
  assert.equal(
    (
      await checkSettings(
        await temporaryDirectory(),
        ['--setting-sources=', '--tools', 'default'],
        {},
      )
    ).tools,
    undefined,
  );
  assert.deepEqual(
    (
      await checkSettings(
        await temporaryDirectory(),
        ['--setting-sources=', '--tools', 'Read', 'Grep'],
        {},
      )
    ).tools,
    ['Read', 'Grep'],
  );
});

function commandError(
  code: string | number,
  stderr: string,
): NodeJS.ErrnoException & { stderr: string } {
  const error = new Error(stderr) as NodeJS.ErrnoException & { stderr: string };
  error.code = code as NodeJS.ErrnoException['code'];
  error.stderr = stderr;
  return error;
}

function absentManagedFiles(): Pick<HarnessSettingsOptions, 'readDir' | 'readFile'> {
  return {
    readDir: async () => {
      throw commandError('ENOENT', 'missing');
    },
    readFile: (async () => {
      throw commandError('ENOENT', 'missing');
    }) as unknown as typeof fs.readFile,
  };
}

for (const platform of ['darwin', 'win32'] as const) {
  test(`native ${platform} managed policy command distinguishes absent, invalid, and unavailable`, async () => {
    const absentMessage =
      platform === 'darwin'
        ? 'The domain/default pair of (com.anthropic.claudecode, ...) does not exist'
        : 'ERROR: The system was unable to find the specified registry key or value.';
    const command = platform === 'darwin' ? 'defaults' : 'reg';
    const commands: string[] = [];
    const absent = await checkSettings(
      '/workspace',
      ['--setting-sources='],
      {},
      {
        platform,
        ...absentManagedFiles(),
        runCommand: async (name) => {
          commands.push(name);
          throw commandError(1, absentMessage);
        },
      },
    );
    assert.deepEqual(absent.disallowedTools, []);
    assert.ok(commands.every((name) => name === command));

    await assert.rejects(
      checkSettings(
        '/workspace',
        ['--setting-sources='],
        {},
        {
          platform,
          ...absentManagedFiles(),
          runCommand: async () => 'unparsable policy output',
        },
      ),
      /cannot parse managed policy output as JSON/,
    );

    await assert.rejects(
      checkSettings(
        '/workspace',
        ['--setting-sources='],
        {},
        {
          platform,
          ...absentManagedFiles(),
          runCommand: async () => {
            throw commandError('ENOENT', `${command} is unavailable`);
          },
        },
      ),
      new RegExp(`cannot observe managed policy via ${command}`),
    );
  });
}

test('native macOS policy treats the macOS 27 missing-domain message as absent', async () => {
  const policy = await checkSettings(
    '/workspace',
    ['--setting-sources='],
    {},
    {
      platform: 'darwin',
      ...absentManagedFiles(),
      runCommand: async () => {
        throw commandError(1, "Error: Domain 'com.anthropic.claudecode' not found.");
      },
    },
  );
  assert.deepEqual(policy.disallowedTools, []);

  await assert.rejects(
    checkSettings(
      '/workspace',
      ['--setting-sources='],
      {},
      {
        platform: 'darwin',
        ...absentManagedFiles(),
        runCommand: async () => {
          throw commandError(1, 'Error: Could not read preferences.');
        },
      },
    ),
    /cannot observe managed policy via defaults/,
  );
});

const frenchRegistryAbsent =
  "Erreur : le syst\uFFFDme n'a pas trouv\uFFFD la cl\uFFFD ou la valeur de Registre sp\uFFFDcifi\uFFFDe.";

test('native Windows policy resolves localized reg failures through PowerShell', async () => {
  const commands: string[][] = [];
  const policy = await checkSettings(
    'C:\\workspace',
    ['--setting-sources='],
    {},
    {
      platform: 'win32',
      ...absentManagedFiles(),
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        if (command === 'reg') {
          throw commandError(1, frenchRegistryAbsent);
        }
        if (String(args.at(-1)).includes("'HKCU:\\SOFTWARE\\Policies\\ClaudeCode'")) {
          return '{"permissions":{"deny":["Bash"]}}';
        }
        throw commandError(3, '');
      },
    },
  );
  assert.deepEqual(policy.disallowedTools, ['Bash']);
  assert.deepEqual(
    commands.map((command) => command.slice(0, 2).join(' ')),
    ['reg query', 'powershell.exe -NoProfile', 'reg query', 'powershell.exe -NoProfile'],
  );
  const script = String(commands[1].at(-1));
  assert.match(script, /Get-Item -LiteralPath 'HKLM:\\SOFTWARE\\Policies\\ClaudeCode'/);
  assert.match(script, /ObjectNotFound.*exit 3/);
  assert.doesNotMatch(script, /[^\x20-\x7e\n]/);
  assert.match(script, /\ntry \{[^\n]*\}\ncatch \{/);
});

test('native Windows policy keeps failing when neither reg nor PowerShell can classify', async () => {
  for (const failure of [
    commandError(1, 'Access denied'),
    commandError('ENOENT', 'no powershell'),
  ]) {
    const commands: string[] = [];
    await assert.rejects(
      checkSettings(
        'C:\\workspace',
        ['--setting-sources='],
        {},
        {
          platform: 'win32',
          ...absentManagedFiles(),
          runCommand: async (command) => {
            commands.push(command);
            if (command === 'reg') {
              throw commandError(1, frenchRegistryAbsent);
            }
            throw failure;
          },
        },
      ),
      /cannot observe managed policy via reg or PowerShell for HKLM/,
    );
    assert.deepEqual(commands, ['reg', 'powershell.exe']);
  }
  await assert.rejects(
    checkSettings(
      'C:\\workspace',
      ['--setting-sources='],
      {},
      {
        platform: 'win32',
        ...absentManagedFiles(),
        runCommand: async () => {
          throw commandError(2, frenchRegistryAbsent);
        },
      },
    ),
    /cannot observe managed policy via reg:/,
  );
});

test('native settings admission discovers macOS managed preferences', async () => {
  const commands: string[][] = [];
  const policy = await checkSettings(
    '/workspace',
    ['--setting-sources='],
    {},
    {
      platform: 'darwin',
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        return JSON.stringify({ permissions: { deny: ['Bash'] } });
      },
      readDir: async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
      readFile: (async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }) as unknown as typeof fs.readFile,
    },
  );
  assert.deepEqual(policy.disallowedTools, ['Bash']);
  assert.deepEqual(commands, [['defaults', 'read', 'com.anthropic.claudecode']]);
});

test('native settings admission discovers Windows HKLM and HKCU registry policies', async () => {
  const commands: string[][] = [];
  const policy = await checkSettings(
    'C:\\workspace',
    ['--setting-sources='],
    {},
    {
      platform: 'win32',
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === 'query' && args[1]?.startsWith('HKLM')) {
          return 'HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Policies\\\\ClaudeCode\\n    Settings    REG_SZ    {"permissions":{"deny":["Write"]}}';
        }
        return '';
      },
      readDir: async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
      readFile: (async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }) as unknown as typeof fs.readFile,
    },
  );
  assert.deepEqual(policy.disallowedTools, ['Write']);
  assert.equal(commands.length, 2);
  assert.match(commands[0].join(' '), /HKLM.*ClaudeCode/);
  assert.match(commands[1].join(' '), /HKCU.*ClaudeCode/);
});

test('native settings admission treats WSL as Linux managed file discovery', async () => {
  const files = new Map([
    ['/etc/claude-code/managed-settings.json', '{"permissions":{"deny":["Read"]}}'],
  ]);
  const policy = await checkSettings(
    '/workspace',
    ['--setting-sources='],
    {},
    {
      platform: 'linux',
      osRelease: '6.1.0-microsoft-standard-WSL2',
      readDir: async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
      readFile: (async (file: Parameters<typeof fs.readFile>[0]) => {
        const value = files.get(String(file));
        if (value !== undefined) {
          return value;
        }
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }) as unknown as typeof fs.readFile,
    },
  );
  assert.deepEqual(policy.disallowedTools, ['Read']);
});

test('policy probes use absolute system paths and a bounded timeout', () => {
  assert.equal(
    systemCommandPath('reg', 'win32', { SystemRoot: 'D:\\Win' }),
    'D:\\Win\\System32\\reg.exe',
  );
  assert.equal(
    systemCommandPath('powershell.exe', 'win32', {}),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(systemCommandPath('defaults', 'darwin'), '/usr/bin/defaults');
  assert.ok(policyCommandTimeoutMs > 0 && policyCommandTimeoutMs <= 30_000);
});

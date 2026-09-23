import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  setup as installSetup,
  uninstall as installUninstall,
  readInstallation,
} from '../../plugins/multi-core/src/install/installation.ts';
import {
  providerSelection,
  settingsArguments,
} from '../../plugins/multi-core/src/install/plugins.ts';
import { removeTemporary } from '../temporary.ts';

const execute = promisify(execFile);

function windowsInvocation(pathname: string, args: string[], env: NodeJS.ProcessEnv) {
  const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
  const commandLine = [pathname, ...args].map(quote).join(' ');
  return {
    command: env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
const setup = fileURLToPath(new URL('../../plugins/multi-core/src/setup.ts', import.meta.url));
const marketplace = 'cc-multi-cli-plugin';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-install-'));
  t.after(() => removeTemporary(directory));
  const platform = process.platform;
  const windows = platform === 'win32';
  const home = path.join(directory, "home with spaces and 'quotes'");
  await mkdir(home);
  const shell = windows
    ? path.join(home, 'profile.ps1')
    : path.join(home, process.platform === 'darwin' ? '.zshrc' : '.bashrc');
  await writeFile(
    shell,
    windows ? '# user settings\r\n' : '# user settings\nexport EXISTING=retained\n',
  );
  const listing = path.join(directory, 'plugins.json');
  await writeFile(listing, '[]');
  const source = path.join(directory, 'real-claude.js');
  const script = `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('plugin') && args.includes('list')) {
  console.log(fs.readFileSync(process.env.TEST_PLUGIN_LIST, 'utf8'));
} else {
  console.log(JSON.stringify({native:true,args}));
  process.exitCode = Number(process.env.TEST_EXIT || 0);
}
`;
  await writeFile(source, script);
  const real = windows
    ? path.join(directory, 'real-claude.cmd')
    : path.join(directory, 'real-claude');
  if (windows) {
    await writeFile(real, `@"${process.execPath}" "${source}" %*\r\n`);
  } else {
    await writeFile(real, `#!${process.execPath}\n${script}`, { mode: 0o755 });
  }
  const env = windows
    ? {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        PSModulePath: process.env.PSModulePath ?? path.join(home, 'PowerShell', 'Modules'),
        PROFILE: shell,
        TEST_PLUGIN_LIST: listing,
      }
    : {
        PATH: process.env.PATH,
        HOME: home,
        SHELL: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
        TEST_PLUGIN_LIST: listing,
      };
  const install = (flags: string[] = []) =>
    execute(process.execPath, [setup, '--claude', real, ...flags], { env });
  const bin = path.join(home, '.local/share/multi-cli/bin');
  const invoke = (name: string, args: string[], extra: Record<string, string> = {}) => {
    const executable = path.join(bin, windows ? `${name}.cmd` : name);
    const invocation = windows
      ? windowsInvocation(executable, args, env)
      : { command: executable, args, windowsVerbatimArguments: false };
    return execute(invocation.command, invocation.args, {
      cwd: directory,
      env: { ...env, ...extra },
      timeout: 20000,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  };
  return { directory, home, shell, listing, real, env, install, invoke, windows };
}

async function waitForMissing(file: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await access(file);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${file} to disappear`);
}

async function core(directory: string, name: string) {
  const root = path.join(directory, name);
  await mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(root, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'multi-core' }),
  );
  const src = path.join(root, 'plugins/multi-core/src');
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, 'launcher.ts'),
    `console.log(JSON.stringify({root:import.meta.url,args:process.argv.slice(2),providers:process.env.MULTI_ENABLED_PROVIDERS,claude:process.env.MULTI_REAL_CLAUDE,models:process.env.MULTI_MODELS ?? null}));`,
  );
  return root;
}

function plugins(root: string, zen = true) {
  return [
    { id: `multi-core@${marketplace}`, enabled: true, scope: 'user', installPath: root },
    {
      id: `multi-zen@${marketplace}`,
      enabled: zen,
      scope: 'user',
      installPath: path.join(root, 'zen'),
    },
    {
      id: `multi-cursor@${marketplace}`,
      enabled: false,
      scope: 'user',
      installPath: path.join(root, 'cursor'),
    },
  ];
}

test('setup preserves shell content, is repeatable, and uninstall survives plugin removal', async (t) => {
  const f = await fixture(t);
  await f.install();
  const once = await readFile(f.shell, 'utf8');
  await f.install();
  assert.equal(await readFile(f.shell, 'utf8'), once);
  const laterEdit = f.windows ? '# later user edit\r\n' : '# later user edit\n';
  await writeFile(f.shell, `${once}${laterEdit}`);
  const reply = JSON.parse((await f.invoke('claude-multi', ['hello world'])).stdout);
  assert.deepEqual(reply, { native: true, args: ['hello world'] });
  await f.invoke('multi', ['uninstall']);
  const original = f.windows
    ? '# user settings\r\n'
    : '# user settings\nexport EXISTING=retained\n';
  assert.equal(await readFile(f.shell, 'utf8'), `${original}${laterEdit}`);
  if (f.windows) {
    await waitForMissing(path.join(f.home, '.local/share/multi-cli/bin/claude-multi.cmd'));
  } else {
    await assert.rejects(f.invoke('claude-multi', []), /ENOENT/);
  }
  await f.install();
  assert.equal(JSON.parse((await f.invoke('claude-multi', [])).stdout).native, true);
});

test('wrapper follows installed core updates and enables only selected providers', async (t) => {
  const f = await fixture(t);
  await f.install();
  const old = await core(f.directory, 'core-v1');
  await writeFile(f.listing, JSON.stringify(plugins(old)));
  const args = ['--settings', '{"model":"sonnet"}', '--', 'literal $() and spaces'];
  const first = JSON.parse((await f.invoke('claude-multi', args)).stdout);
  assert.deepEqual(first.args, args);
  assert.equal(first.providers, 'zen');
  assert.equal(first.claude, f.real);
  const next = path.join(f.directory, 'core-v2');
  await cp(old, next, { recursive: true });
  await rm(old, { recursive: true });
  await writeFile(f.listing, JSON.stringify(plugins(next)));
  assert.match(JSON.parse((await f.invoke('claude-multi', [])).stdout).root, /core-v2/);
  await writeFile(f.listing, JSON.stringify(plugins(next, false)));
  assert.equal(JSON.parse((await f.invoke('claude-multi', [])).stdout).native, true);
});

test('setup renames the launch command, persists picker models, and keeps them across reruns', async (t) => {
  const f = await fixture(t);
  const root = await core(f.directory, 'core');
  await writeFile(f.listing, JSON.stringify(plugins(root)));
  const stateFile = path.join(f.home, '.local/share/multi-cli/state.json');
  const shim = (name: string) =>
    path.join(f.home, '.local/share/multi-cli/bin', f.windows ? `${name}.cmd` : name);
  const first = await f.install(['--command', 'mc', '--models', 'multi/zen/kimi-k2.5']);
  assert.match(first.stdout, /start mc\./);
  assert.match(first.stdout, /shows only: multi\/zen\/kimi-k2\.5/);
  await assert.rejects(access(shim('claude-multi')), /ENOENT/);
  const custom = JSON.parse((await f.invoke('mc', [])).stdout);
  assert.equal(custom.models, 'multi/zen/kimi-k2.5');
  assert.equal(custom.providers, 'zen');
  // An explicit environment selection still wins for one launch.
  const explicit = JSON.parse((await f.invoke('mc', [], { MULTI_MODELS: '' })).stdout);
  assert.equal(explicit.models, '');
  // Re-running setup without flags keeps the customization.
  await f.install();
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).command, 'mc');
  assert.equal(JSON.parse((await f.invoke('mc', [])).stdout).models, 'multi/zen/kimi-k2.5');
  await f.install(['--models', '+multi/zen/glm-5.2']);
  assert.equal(
    JSON.parse((await f.invoke('mc', [])).stdout).models,
    'multi/zen/kimi-k2.5,multi/zen/glm-5.2',
  );
  // `none` hides external rows; `all` requests the full connected catalog.
  await f.install(['--models', 'none']);
  assert.equal(JSON.parse((await f.invoke('mc', [])).stdout).models, '');
  await f.install(['--models', 'all']);
  assert.equal(JSON.parse((await f.invoke('mc', [])).stdout).models, 'all');
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).models, 'all');
  // Renaming removes the previous shim and uninstall removes the current one.
  await f.install(['--command', 'claude-multi']);
  await assert.rejects(access(shim('mc')), /ENOENT/);
  assert.equal(JSON.parse((await f.invoke('claude-multi', [])).stdout).providers, 'zen');
  await assert.rejects(f.install(['--command', 'multi']), /reserved/);
  await assert.rejects(f.install(['--command', 'bad name']), /Invalid launch command/);
  await assert.rejects(f.install(['--models', 'gpt-6-astra']), /Invalid picker model/);
  // A picker row can display a context tag, so that is the spelling a user copies out of
  // /model. It names a row and must persist as the untagged ID, which stays valid whether
  // or not the tag is on, and must not persist twice alongside its own plain spelling.
  await f.install([
    '--models',
    'multi/antigravity/gemini-3.8-flash[1m],multi/antigravity/gemini-3.8-flash',
  ]);
  assert.equal(
    JSON.parse(await readFile(stateFile, 'utf8')).models,
    'multi/antigravity/gemini-3.8-flash',
  );
  await f.invoke('multi', ['uninstall']);
  if (f.windows) {
    await waitForMissing(shim('claude-multi'));
  } else {
    await assert.rejects(access(shim('claude-multi')), /ENOENT/);
  }
});

test('a launch command named claude passes nested runs through to the real executable', async (t) => {
  const f = await fixture(t);
  const root = await core(f.directory, 'core');
  await writeFile(f.listing, JSON.stringify(plugins(root)));
  const install = await f.install(['--command', 'claude']);
  assert.match(install.stderr, /shadows the plain claude command/);
  assert.equal(JSON.parse((await f.invoke('claude', [])).stdout).providers, 'zen');
  const nested = JSON.parse(
    (await f.invoke('claude', ['-p', 'hi'], { MULTI_GATEWAY_TOKEN: 'token' })).stdout,
  );
  assert.deepEqual(nested, { native: true, args: ['-p', 'hi'] });
});

test('edited shell blocks and project-only executable cores fail explicitly', async (t) => {
  const f = await fixture(t);
  await f.install();
  const current = await readFile(f.shell, 'utf8');
  const pathMarker = f.windows ? '$env:Path = ' : 'export PATH=';
  assert(current.includes(pathMarker), 'fixture must contain the recorded Multi PATH block');
  await writeFile(f.shell, current.replace(pathMarker, '# changed PATH='));
  await assert.rejects(f.invoke('multi', ['uninstall']), /was edited/);
  await assert.rejects(f.install(), /was edited/);
  const entries = plugins(await core(f.directory, 'project-core'));
  entries[0].scope = 'project';
  await writeFile(f.listing, JSON.stringify(entries));
  await assert.rejects(f.invoke('claude-multi', []), /user scope/);
});

test('Windows installation writes quoted PowerShell and cmd shims and uninstalls exactly', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-win-install-'));
  t.after(() => removeTemporary(directory));
  const home = path.join(directory, "home with spaces and 'quotes'");
  await mkdir(home, { recursive: true });
  const profile = path.join(home, 'profile.ps1');
  await writeFile(profile, '# existing profile\r\n');
  const state = await installSetup('powershell', process.execPath, {
    platform: 'win32',
    homedir: home,
    env: { PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD', PROFILE: profile },
  });
  const bin = path.join(home, '.local', 'share', 'multi-cli', 'bin');
  const cmd = await readFile(path.join(bin, 'claude-multi.cmd'), 'utf8');
  const ps = await readFile(path.join(bin, 'claude-multi.ps1'), 'utf8');
  assert.match(cmd, /".*" ".*bootstrap\.ts"(?: --multi)? %\*/);
  assert.equal(cmd.split('\r\n').filter(Boolean).length, 1, 'single-line shim survives uninstall');
  assert.match(cmd, /^@goto #_undefined_# 2>NUL \|\| ".*" ".*bootstrap\.ts" %\*\r\n$/);
  assert.match(ps, /''quotes''|quotes/);
  assert.match(state.block, /\$env:Path/);
  let deferredCommand = '';
  let deferredArgs: string[] = [];
  let deferredOptions: object = {};
  await installUninstall(path.dirname(bin), {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    deferDeletion: (command, args, options) => {
      deferredCommand = command;
      deferredArgs = args;
      deferredOptions = options;
    },
  });
  assert.equal(await readFile(profile, 'utf8'), '# existing profile\r\n');
  assert.deepEqual(deferredArgs, [
    '/d',
    '/s',
    '/c',
    `"ping -n 2 127.0.0.1 >nul & del /f /q "${path.join(bin, 'claude-multi.cmd')}" "${path.join(bin, 'multi.cmd')}" & rmdir "${bin}" & rmdir "${path.dirname(bin)}""`,
  ]);
  assert.equal(deferredCommand, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(deferredOptions, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  await removeTemporary(directory);
});

test('Windows executable discovery uses PATHEXT and does not require mode bits', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-win-resolution-'));
  t.after(() => removeTemporary(directory));
  const home = path.join(directory, 'home');
  const bin = path.join(home, 'npm global bin');
  await mkdir(bin, { recursive: true });
  const claude = path.join(bin, 'claude.CMD');
  await writeFile(claude, 'shim');
  const state = await installSetup('pwsh', claude, {
    platform: 'win32',
    homedir: home,
    env: { PATH: bin, PATHEXT: '.CMD', PROFILE: path.join(home, 'profile.ps1') },
  });
  assert.equal(state.claude, claude);
});

test('provider selection and native settings arguments preserve explicit disablement', () => {
  assert.equal(providerSelection(undefined), undefined);
  assert.deepEqual(providerSelection(''), []);
  assert.deepEqual(providerSelection('zen,zen,openai'), ['zen', 'openai']);
  assert.throws(() => providerSelection('typo'), /Unknown Multi provider/);
  assert.deepEqual(
    settingsArguments([
      '--model',
      'sonnet',
      '--settings={"enabledPlugins":{}}',
      '--setting-sources',
      'user',
      '--',
      '--settings=x',
    ]),
    ['--settings={"enabledPlugins":{}}', '--setting-sources', 'user'],
  );
  assert.throws(() => settingsArguments(['--settings']), /requires a value/);
});

test('readInstallation rejects relative persisted executable and shell paths', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-install-state-'));
  t.after(() => removeTemporary(directory));
  const valid = {
    claude: path.resolve('claude'),
    node: path.resolve('node'),
    shellFile: path.resolve('shell'),
    block: 'block',
  };
  for (const field of ['claude', 'node', 'shellFile'] as const) {
    await writeFile(
      path.join(directory, 'state.json'),
      JSON.stringify({ ...valid, [field]: 'relative/path' }),
    );
    await assert.rejects(readInstallation(directory), {
      message: 'Invalid Multi installation state',
    });
  }
});

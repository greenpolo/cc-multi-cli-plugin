/** Real plugin-manager smoke in a temporary home. Downloads npm packages, no inference. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  cp,
  constants as fsConstants,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isolatedEnvironment } from './environment.ts';

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

const repository = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-installed-'));
const source = path.join(directory, 'marketplace');
const home = path.join(directory, 'home');
console.log(`Installation artifacts: ${directory}`);
await mkdir(source);
await mkdir(home);
for (const entry of [
  '.claude-plugin',
  'plugins',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'NOTICE',
]) {
  await cp(path.join(repository, entry), path.join(source, entry), { recursive: true });
}
const platform = process.platform;
let shell = 'bash';
if (platform === 'darwin') {
  shell = 'zsh';
} else if (platform === 'win32') {
  shell = 'powershell';
}
const profile =
  platform === 'win32'
    ? path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    : path.join(home, shell === 'zsh' ? '.zshrc' : '.bashrc');
const env = isolatedEnvironment({
  HOME: home,
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  ...(platform === 'win32'
    ? {
        // npm, cmd.exe and the plugin manager need the Windows system variables;
        // without TEMP, APPDATA and PATHEXT the dependency install fails quietly.
        PSModulePath: process.env.PSModulePath ?? path.join(home, 'PowerShell', 'Modules'),
        ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        USERPROFILE: home,
        PROFILE: profile,
      }
    : { SHELL: `/${shell}` }),
  npm_config_omit: 'dev',
});
async function native(args: string[]) {
  return execute('claude', args, {
    cwd: directory,
    env,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
}
await native(['plugin', 'marketplace', 'add', source]);
const installation = await native([
  'plugin',
  'install',
  'multi-zen@cc-multi-cli-plugin',
  '--scope',
  'user',
]);
console.log(installation.stdout.trim());
const listing = await native(['plugin', 'list', '--json']);
await writeFile(path.join(directory, 'installed.json'), listing.stdout);
const plugins: { id: string; enabled: boolean; installPath: string }[] = JSON.parse(listing.stdout);
const core = plugins.find((plugin) => plugin.id === 'multi-core@cc-multi-cli-plugin');
assert(core?.enabled, 'Provider installation must install and enable core');
const launcher = path.join(core.installPath, 'plugins/multi-core/src/launcher.ts');
await rename(source, `${source}-removed`);
const catalog = await execute(process.execPath, [launcher, '--zen-models'], {
  cwd: directory,
  env,
  timeout: 30000,
});
assert(JSON.parse(catalog.stdout).some((model: { id: string }) => model.id === 'kimi-k3'));
await rename(`${source}-removed`, source);

// Exercise the real cached gateway and picker, replacing only the outer Claude UI.
const fakeSource = path.join(directory, 'claude-fixture.js');
const fake =
  platform === 'win32'
    ? path.join(directory, 'claude-fixture.cmd')
    : path.join(directory, 'claude-fixture');
// Same fake as the launcher unit tests: answers the version, plugin-list and
// auth probes and acknowledges the Mods session, then reports the picker.
const fakeScript = `const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('plugin')&&args.includes('list')){console.log('[]');process.exit(0)}
if(args[0]==='--version'){console.log(process.env.TEST_CLAUDE_VERSION??'2.1.272');process.exit(0)}
const result=(value)=>{const base=process.env.MULTI_MOD_GATEWAY_URL;if(!base){console.log(value);return}const url=new URL(base+'/multi/mod/session');const req=require('node:http').request(url,{method:'POST',headers:{'content-type':'application/json','x-multi-gateway-token':process.env.MULTI_GATEWAY_TOKEN}},()=>console.log(value));req.on('error',()=>console.log(value));req.end(JSON.stringify({sessionId:'fixture',event:'start'}));};
if(args[0]==='auth'){process.stdout.write(JSON.stringify({loggedIn:false}));process.exitCode=1}else{
const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
result(JSON.stringify(settings.modelPicker.options.map(x=>x.model)));}
`;
await writeFile(fakeSource, fakeScript);
if (platform === 'win32') {
  // The same layout npm writes for global installs, so the launcher's shim
  // bypass runs the fixture through Node directly instead of cmd.exe.
  await writeFile(
    fake,
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${path.basename(fakeSource)}" %*\r\n`,
  );
} else {
  await writeFile(fake, `#!${process.execPath}\n${fakeScript}`, { mode: 0o755 });
}
const launched = await execute(process.execPath, [launcher], {
  cwd: directory,
  timeout: 30000,
  env: isolatedEnvironment({
    ...env,
    MULTI_REAL_CLAUDE: fake,
    MULTI_ENABLED_PROVIDERS: 'zen',
    OPENCODE_API_KEY: 'fixture-key',
  }),
});
const models: string[] = JSON.parse(launched.stdout);
assert(models.length > 0 && models.every((model) => model.startsWith('multi/zen/')));

await execute(
  process.execPath,
  [path.join(core.installPath, 'plugins/multi-core/src/setup.ts'), '--shell', shell],
  { env, cwd: directory },
);
const bin = path.join(home, '.local', 'share', 'multi-cli', 'bin');
// Desktop sessions: setup names the front door's trust file in Claude's user settings.
const claudeSettings = path.join(home, '.claude', 'settings.json');
const trustFile = path.join(home, '.local', 'share', 'multi-cli', 'front-door', 'trust.pem');
const installedSettings = JSON.parse(await readFile(claudeSettings, 'utf8'));
assert.equal(installedSettings.env?.NODE_EXTRA_CA_CERTS, trustFile);
assert.match(await readFile(trustFile, 'utf8'), /BEGIN CERTIFICATE/);
const multi = platform === 'win32' ? path.join(bin, 'multi.cmd') : path.join(bin, 'multi');
if (platform === 'win32') {
  await access(path.join(bin, 'claude-multi.cmd'));
  await access(path.join(bin, 'claude-multi.ps1'));
  // Setup must never write a bin/claude that would shadow the real claude command.
  await assert.rejects(access(path.join(bin, 'claude.cmd')));
} else {
  await access(path.join(bin, 'claude-multi'), fsConstants.X_OK);
  // Setup must never write a bin/claude that would shadow the real claude command.
  await assert.rejects(access(path.join(bin, 'claude'), fsConstants.X_OK));
}
const statusInvocation =
  platform === 'win32'
    ? windowsInvocation(multi, ['status'], env)
    : { command: multi, args: ['status'], windowsVerbatimArguments: false };
const status = await execute(statusInvocation.command, statusInvocation.args, {
  env,
  cwd: directory,
  windowsVerbatimArguments: statusInvocation.windowsVerbatimArguments,
});
assert.deepEqual(JSON.parse(status.stdout).providers, ['zen']);
const disabledArgs = [
  'status',
  '--settings',
  JSON.stringify({ enabledPlugins: { 'multi-zen@cc-multi-cli-plugin': false } }),
];
const disabledInvocation =
  platform === 'win32'
    ? windowsInvocation(multi, disabledArgs, env)
    : { command: multi, args: disabledArgs, windowsVerbatimArguments: false };
const disabled = await execute(disabledInvocation.command, disabledInvocation.args, {
  env,
  cwd: directory,
  windowsVerbatimArguments: disabledInvocation.windowsVerbatimArguments,
});
assert.deepEqual(JSON.parse(disabled.stdout).providers, []);
const uninstallInvocation =
  platform === 'win32'
    ? windowsInvocation(multi, ['uninstall'], env)
    : { command: multi, args: ['uninstall'], windowsVerbatimArguments: false };
await execute(uninstallInvocation.command, uninstallInvocation.args, {
  env,
  cwd: directory,
  windowsVerbatimArguments: uninstallInvocation.windowsVerbatimArguments,
});
assert.equal(await readFile(profile, 'utf8'), '');
const restoredSettings = JSON.parse(await readFile(claudeSettings, 'utf8'));
assert.equal(restoredSettings.env?.NODE_EXTRA_CA_CERTS, undefined);
assert.equal(restoredSettings.modelPicker, undefined);
await assert.rejects(access(trustFile));
console.log(
  'PASS: core dependency, isolated cache, gateway picker, native enablement, claude-multi without shadowing claude, setup and uninstall (desktop settings restored). No inference requests.',
);

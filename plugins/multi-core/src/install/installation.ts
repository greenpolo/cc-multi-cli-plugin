import { type SpawnOptions, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const begin = '# >>> multi-cli >>>';
const end = '# <<< multi-cli <<<';
const files = ['bootstrap.ts', 'installation.ts', 'plugins.ts', 'process.ts'];

type Platform = NodeJS.Platform;

export interface Installation {
  claude: string;
  node: string;
  shellFile: string;
  block: string;
  platform?: Platform;
  shims?: string[];
  /** Launch command name; `claude-multi` unless customized. */
  command?: string;
  /** Persisted `MULTI_MODELS` picker selection; undefined keeps launcher defaults. */
  models?: string;
}

export interface InstallationOptions {
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  shell?: string;
  command?: string;
  /** Picker rows to show: `all`, `none`, IDs, or `+<ids>` to extend the saved selection. */
  models?: string;
}

export const DEFAULT_COMMAND = 'claude-multi';
/** The management shim; `<command> --multi` and `multi` reach the same dispatcher. */
const MANAGEMENT_COMMAND = 'multi';

type DeferDeletion = (command: string, args: string[], options: SpawnOptions) => void;

export interface UninstallOptions {
  platform?: Platform;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  deferDeletion?: DeferDeletion;
}

function optionsFor(options: InstallationOptions = {}) {
  return {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    homedir: options.homedir ?? os.homedir(),
  };
}

function installationDirectory(homedir = os.homedir()) {
  return path.join(homedir, '.local', 'share', 'multi-cli');
}

function posixQuote(value: string) {
  if (/[\r\n\0]/.test(value)) {
    throw new Error('Newlines and NUL are unsupported in installation paths');
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value: string) {
  if (/[\r\n\0]/.test(value)) {
    throw new Error('Newlines and NUL are unsupported in installation paths');
  }
  return `'${value.replaceAll("'", "''")}'`;
}

async function optionalText(file: string) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

export async function readInstallation(directory = installationDirectory()): Promise<Installation> {
  const value = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  if (
    !value ||
    !['claude', 'node', 'shellFile', 'block'].every((key) => typeof value[key] === 'string') ||
    ![value.claude, value.node, value.shellFile].every((file) => path.isAbsolute(file)) ||
    !['command', 'models'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    )
  ) {
    throw new Error('Invalid Multi installation state');
  }
  return value;
}

/** Shim names become files in the PATH directory, so allow only plain names. */
function validateCommand(command: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(command)) {
    throw new Error(
      `Invalid launch command name: ${JSON.stringify(command)}. Use letters, digits, dots, dashes or underscores.`,
    );
  }
  if (command.toLowerCase() === MANAGEMENT_COMMAND) {
    throw new Error(`The name ${MANAGEMENT_COMMAND} is reserved for Multi management commands.`);
  }
  return command;
}

/** Normalize a `--models` value: `all` requests the full connected catalog. */
function normalizeModels(value: string | undefined, previous?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().toLowerCase() === 'all') {
    return 'all';
  }
  if (value.trim().toLowerCase() === 'none') {
    return '';
  }
  const additive = value.trim().startsWith('+');
  const models = (additive ? value.trim().slice(1) : value)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  if (additive && models.length === 0) {
    throw new Error('Add at least one full model ID after --models +.');
  }
  // A picker row may display a context tag, so that is the spelling a user copies out of
  // /model and pastes here. Accept it and store the untagged ID, which is the stable one:
  // it still names the row whether or not the tag is switched on later. The strip is
  // spelled out rather than imported because this file is installed on its own, with no
  // sibling plugin sources beside it; `nativeSpelling()` in gateway/provider.ts is the
  // canonical definition.
  const persisted = models.map((model) => model.replace(/\[1m\]$/i, ''));
  for (const model of persisted) {
    if (!/^multi\/[a-z]+\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) {
      throw new Error(
        `Invalid picker model ID: ${JSON.stringify(model)}. Use full IDs such as multi/openai/gpt-6-astra, or all/none.`,
      );
    }
  }
  if (!additive) {
    return [...new Set(persisted)].join(',');
  }
  if (previous === 'all') {
    return 'all';
  }
  const base = previous?.startsWith('+') ? previous.slice(1) : previous;
  const combined = [...new Set([...(base ? base.split(',') : []), ...persisted])].join(',');
  return previous === undefined || previous.startsWith('+') ? `+${combined}` : combined;
}

/** Preserve the public executable path so Claude's own updater can replace its target. */
async function findClaude(
  explicit: string | undefined,
  platform: Platform,
  env: NodeJS.ProcessEnv,
) {
  const pathValue = env.PATH ?? '';
  const extensions =
    platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const candidates = explicit
    ? [explicit]
    : pathValue
        .split(path.delimiter)
        .flatMap((directory) =>
          extensions.map((extension) => path.join(directory, `claude${extension.toLowerCase()}`)),
        );
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) {
      continue;
    }
    try {
      if (platform === 'win32') {
        await access(candidate);
      } else {
        await access(candidate, constants.X_OK);
      }
      return candidate;
    } catch {
      // Continue searching PATH for an executable.
    }
  }
  throw new Error(
    'Cannot find the real Claude executable. Pass --claude /absolute/path/to/claude.',
  );
}

function normalizeLineEndings(source: string) {
  return source.replaceAll('\r\n', '\n');
}

function removeBlock(source: string, block: string) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  const recorded = start >= 0 && finish >= 0 ? source.slice(start, finish + end.length) : '';
  if (normalizeLineEndings(recorded) !== normalizeLineEndings(block.trim())) {
    throw new Error('Multi shell configuration was edited; refusing to overwrite it.');
  }
  const blockStart = start > 0 && source[start - 1] === '\n' ? start - 1 : start;
  const blockEnd =
    finish + end.length < source.length && source[finish + end.length] === '\n'
      ? finish + end.length + 1
      : finish + end.length;
  return `${source.slice(0, blockStart)}${source.slice(blockEnd)}`;
}

function validateRuntime(shell: string, platform: Platform) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 12)) {
    throw new Error('Multi setup requires Node >= 24.12 on PATH.');
  }
  const supported =
    platform === 'win32' ? ['powershell', 'pwsh', 'cmd', 'cmd.exe'] : ['bash', 'zsh', 'fish'];
  if (!supported.includes(shell.toLowerCase())) {
    throw new Error(
      platform === 'win32'
        ? 'Multi setup supports PowerShell or cmd on Windows. Use --shell powershell or --shell cmd.'
        : 'Multi setup supports Bash, Zsh, or fish on macOS/Linux. Use --shell bash, --shell zsh, or --shell fish.',
    );
  }
}

async function previousInstallation(directory: string) {
  if (await optionalText(path.join(directory, 'state.json'))) {
    return readInstallation(directory);
  }
  try {
    if ((await readdir(directory)).length) {
      throw new Error(
        'Multi installation directory contains unrecognized files; refusing to overwrite them.',
      );
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  return undefined;
}

function shellFile(homedir: string, shell: string, platform: Platform, env: NodeJS.ProcessEnv) {
  if (platform === 'win32') {
    return (
      env.PROFILE ??
      path.join(homedir, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    );
  }
  let relative = '.config/fish/config.fish';
  if (shell === 'bash') {
    relative = '.bashrc';
  } else if (shell === 'zsh') {
    relative = '.zshrc';
  }
  return path.join(homedir, relative);
}

function blockFor(bin: string, shell: string, platform: Platform) {
  if (platform === 'win32') {
    return `\n${begin}\n$env:Path = ${powershellQuote(bin)} + [IO.Path]::PathSeparator + $env:Path\n${end}\n`;
  }
  const pathExpression =
    shell === 'fish'
      ? `set -gx PATH ${posixQuote(bin)} $PATH`
      : `export PATH=${posixQuote(bin)}:"$PATH"`;
  return `\n${begin}\n${pathExpression}\n${end}\n`;
}

async function writeShim(
  bin: string,
  node: string,
  bootstrap: string,
  name: string,
  platform: Platform,
) {
  const suffix = name === MANAGEMENT_COMMAND ? ' --multi' : '';
  if (platform === 'win32') {
    // Same trick as npm's cmd shims: a goto to an undefined label ends batch
    // processing, so the `||` branch runs Node as a top-level command. cmd.exe
    // then returns Node's exit code directly (`exit /b` after `&` would return
    // 0 under `cmd /c`) and no longer re-reads this file while Node runs.
    const cmd = `@goto #_undefined_# 2>NUL || "${node}" "${bootstrap}"${suffix} %*\r\n`;
    await writeFile(path.join(bin, `${name}.cmd`), cmd);
    await writeFile(
      path.join(bin, `${name}.ps1`),
      `& ${powershellQuote(node)} ${powershellQuote(bootstrap)}${suffix} @args\r\nexit $LASTEXITCODE\r\n`,
    );
    return [`${name}.cmd`, `${name}.ps1`];
  }
  const script = `#!/bin/sh\nexec ${posixQuote(node)} ${posixQuote(bootstrap)}${suffix} "$@"\n`;
  await writeFile(path.join(bin, name), script, { mode: 0o700 });
  return [name];
}

async function writeRuntime(
  directory: string,
  bin: string,
  node: string,
  platform: Platform,
  command: string,
  staleShims: string[],
) {
  await mkdir(bin, { recursive: true, mode: 0o700 });
  for (const stale of staleShims) {
    await rm(path.join(bin, stale), { force: true });
  }
  for (const file of files) {
    const origin = fileURLToPath(new URL(file, import.meta.url));
    const destination = path.join(directory, file);
    if (origin !== destination) {
      await copyFile(origin, destination);
    }
  }
  const gatewayDirectory = path.join(directory, '..', 'gateway');
  await mkdir(gatewayDirectory, { recursive: true });
  for (const file of ['executable.ts', 'process-tree.ts']) {
    const origin = fileURLToPath(new URL(`../gateway/${file}`, import.meta.url));
    await copyFile(origin, path.join(gatewayDirectory, file));
  }
  const bootstrap = path.join(directory, 'bootstrap.ts');
  const shims: string[] = [];
  for (const name of [command, MANAGEMENT_COMMAND]) {
    shims.push(...(await writeShim(bin, node, bootstrap, name, platform)));
  }
  return shims;
}

export async function setup(
  shell: string,
  explicitClaude?: string,
  options: InstallationOptions = {},
) {
  const resolved = optionsFor(options);
  const normalizedShell = shell.toLowerCase();
  validateRuntime(normalizedShell, resolved.platform);
  const directory = installationDirectory(resolved.homedir);
  const stateFile = path.join(directory, 'state.json');
  const previous = await previousInstallation(directory);
  const startupFile = shellFile(resolved.homedir, normalizedShell, resolved.platform, resolved.env);
  if (previous && previous.shellFile !== startupFile) {
    throw new Error('Uninstall the existing shell integration before changing shells.');
  }
  const claude = await findClaude(
    explicitClaude ?? previous?.claude,
    resolved.platform,
    resolved.env,
  );
  const source = await optionalText(startupFile);
  const original = previous ? removeBlock(source, previous.block) : source;
  if (original.includes(begin) || original.includes(end)) {
    throw new Error('Unrecognized Multi shell block; refusing to modify shell configuration.');
  }
  const node = process.execPath;
  const bin = path.join(directory, 'bin');
  const block = blockFor(bin, normalizedShell, resolved.platform);
  const command = validateCommand(options.command ?? previous?.command ?? DEFAULT_COMMAND);
  const models =
    'models' in options ? normalizeModels(options.models, previous?.models) : previous?.models;
  const shims = await writeRuntime(
    directory,
    bin,
    node,
    resolved.platform,
    command,
    previous?.shims ?? [],
  );
  const state: Installation = {
    claude,
    node,
    shellFile: startupFile,
    block,
    platform: resolved.platform,
    shims,
    command,
    ...(models === undefined ? {} : { models }),
  };
  await writeFile(`${stateFile}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(`${stateFile}.tmp`, stateFile);
  await mkdir(path.dirname(startupFile), { recursive: true });
  await writeFile(startupFile, original + block);
  return state;
}

/**
 * Remove the `multi-cli-antigravity` entry from agy's global hooks file. This file is copied
 * beside the installed shims and must run after the plugin is gone, so it cannot import the
 * plugin's own path helpers; the location logic mirrors `antigravityHookFile`.
 */
export async function removeAntigravityHook(
  options: { platform?: Platform; env?: NodeJS.ProcessEnv; homedir?: string } = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const root =
    platform === 'win32'
      ? lib.join(env.LOCALAPPDATA ?? env.APPDATA ?? lib.join(home, 'AppData', 'Local'), 'gemini')
      : lib.join(home, '.gemini');
  const file = lib.join(root, 'config', 'hooks.json');
  let hooks: unknown;
  try {
    hooks = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  if (
    !hooks ||
    typeof hooks !== 'object' ||
    Array.isArray(hooks) ||
    !('multi-cli-antigravity' in hooks)
  ) {
    return false;
  }
  const remaining = { ...hooks } as Record<string, unknown>;
  delete remaining['multi-cli-antigravity'];
  await writeFile(file, `${JSON.stringify(remaining, null, 2)}\n`, { mode: 0o600 });
  return true;
}

export async function uninstall(
  directory = installationDirectory(),
  options: UninstallOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const state = await readInstallation(directory);
  const source = await readFile(state.shellFile, 'utf8');
  await writeFile(state.shellFile, removeBlock(source, state.block));
  try {
    // The Antigravity permission hook is global to the machine and points into this plugin.
    await removeAntigravityHook({ platform, env: options.env, homedir: options.homedir });
  } catch (error) {
    console.warn(`Could not remove the Antigravity hook: ${String(error)}`);
  }
  const shimFiles = state.shims ?? [DEFAULT_COMMAND, MANAGEMENT_COMMAND];
  const shimPaths = shimFiles.map((file) => path.join(directory, 'bin', file));
  const deferred = platform === 'win32' ? shimPaths.filter((file) => /\.cmd$/i.test(file)) : [];
  const immediate = shimPaths.filter((file) => !deferred.includes(file));
  for (const file of [
    ...files,
    'state.json',
    '../gateway/executable.ts',
    '../gateway/process-tree.ts',
    ...immediate.map((file) => path.relative(directory, file)),
  ]) {
    await rm(path.join(directory, file), { force: true });
  }
  if (deferred.length) {
    const bin = path.join(directory, 'bin');
    const command = `"ping -n 2 127.0.0.1 >nul & del /f /q ${deferred.map((file) => `"${file}"`).join(' ')} & rmdir "${bin}" & rmdir "${directory}""`;
    const deferDeletion =
      options.deferDeletion ??
      ((commandLine, args, spawnOptions) => {
        spawn(commandLine, args, spawnOptions).unref();
      });
    // cmd.exe reopens a running batch file for each line and on exit, so its
    // shims must be removed by a detached process after the parent exits.
    deferDeletion(
      options.env?.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', command],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    );
    return;
  }
  for (const empty of [path.join(directory, 'bin'), directory]) {
    try {
      await rmdir(empty);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY')) {
        throw error;
      }
    }
  }
}

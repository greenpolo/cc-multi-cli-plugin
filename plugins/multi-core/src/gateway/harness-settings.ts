import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pluginPermissions, type WorkerPermissions } from './agent-definitions.ts';
import type { PermissionContext } from './mode-hook.ts';

export interface HarnessSettingsOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  osRelease?: string;
  readFile?: typeof fs.readFile;
  readDir?: typeof fs.readdir;
  runCommand?: (command: string, args: readonly string[]) => Promise<string>;
  /** The harness's own judgement of the merged rules. It must be synchronous: admission
   * throws, and a returned promise would be ignored. */
  validate: (context: PermissionContext) => void;
  /** Judges each settings file's deny rules as it is read, which buys the per-file
   * attribution in the error message. Without it only the merged result is judged. */
  checkRules?: (rules: string[] | undefined) => void;
}

/** Every discovery option resolved to a value; not part of the public surface. */
type SettingsDiscovery = Required<Omit<HarnessSettingsOptions, 'checkRules'>> &
  Pick<HarnessSettingsOptions, 'checkRules'>;

export const policyCommandTimeoutMs = 10_000;

/**
 * Policy probes run from fixed system directories: a bare name would let a
 * Windows working directory (searched first) or a user PATH entry answer for
 * the managed policy.
 */
export function systemCommandPath(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
    const system32 = path.win32.join(root, 'System32');
    if (command === 'powershell.exe') {
      return path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    }
    return path.win32.join(system32, command.endsWith('.exe') ? command : `${command}.exe`);
  }
  return command === 'defaults' ? '/usr/bin/defaults' : command;
}

const defaultRunCommand = (command: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    childProcess.execFile(
      systemCommandPath(command),
      [...args],
      { encoding: 'utf8', timeout: policyCommandTimeoutMs, windowsHide: true, cwd: os.tmpdir() },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stderr });
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });

/** Restriction layers intersect grants and accumulate denials; none can widen another. */
export function mergePermissions(
  context: PermissionContext,
  rules: WorkerPermissions = {},
): PermissionContext {
  let tools = context.tools;
  if (rules.tools !== undefined) {
    tools = tools === undefined ? rules.tools : tools.filter((tool) => rules.tools?.includes(tool));
  }
  return {
    ...context,
    tools,
    disallowedTools: [...(context.disallowedTools ?? []), ...(rules.disallowedTools ?? [])],
  };
}

/** Re-read on each native dispatch; Claude-side rules cannot constrain SDK tools. */
export async function checkHarnessSettings(
  cwd: string,
  args: readonly string[],
  inlineSettings: Record<string, unknown>,
  options: HarnessSettingsOptions,
): Promise<WorkerPermissions> {
  const { sources, restrictions } = settingSources(args);
  await pluginPermissions(cwd, [...args, '--settings', JSON.stringify(inlineSettings)]);
  let context = mergePermissions({ permissionMode: 'auto' }, restrictions);
  const { validate, checkRules } = options;
  const settingsOptions: SettingsDiscovery = {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    osRelease: options.osRelease ?? os.release(),
    readFile: options.readFile ?? fs.readFile,
    readDir: options.readDir ?? fs.readdir,
    runCommand: options.runCommand ?? defaultRunCommand,
    validate,
    checkRules,
  };
  context = mergePolicies(context, await managedSettings(settingsOptions));
  context = mergePermissions(context, claudeSettingsRestrictions(inlineSettings, checkRules));
  if (sources.has('user')) {
    context = mergePermissions(
      context,
      await checkFile(
        path.join(
          settingsOptions.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
          'settings.json',
        ),
        settingsOptions.readFile,
        checkRules,
      ),
    );
  }
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    if (sources.has('project')) {
      context = mergePermissions(
        context,
        await checkFile(
          path.join(directory, '.claude', 'settings.json'),
          settingsOptions.readFile,
          checkRules,
        ),
      );
    }
    if (sources.has('local')) {
      context = mergePermissions(
        context,
        await checkFile(
          path.join(directory, '.claude', 'settings.local.json'),
          settingsOptions.readFile,
          checkRules,
        ),
      );
    }
    if (directory === path.dirname(directory)) {
      break;
    }
  }
  validate(context);
  return { tools: context.tools, disallowedTools: context.disallowedTools };
}

function mergePolicies(
  initial: PermissionContext,
  policies: readonly WorkerPermissions[],
): PermissionContext {
  let context = initial;
  for (const policy of policies) {
    context = mergePermissions(context, policy);
  }
  return context;
}

function settingSources(args: readonly string[]): {
  sources: Set<string>;
  restrictions: WorkerPermissions;
} {
  let context: PermissionContext = { permissionMode: 'auto' };
  let sources = 'user,project,local';
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      break;
    }
    const name = arg.split('=', 1)[0];
    if (
      !['--tools', '--disallowedTools', '--disallowed-tools', '--setting-sources'].includes(name)
    ) {
      continue;
    }
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index];
    if (!value?.match(/^(?!--)/)) {
      throw new Error(`${name} requires a value`);
    }
    if (name === '--setting-sources') {
      sources = value;
    } else {
      const [list, lastIndex] = toolArguments(value, args, index);
      index = lastIndex;
      context = mergePermissions(context, toolRestriction(name, list));
    }
  }
  return { sources: selectedSources(sources), restrictions: context };
}

function selectedSources(sources: string): Set<string> {
  const selected = new Set(sources.split(',').filter(Boolean));
  if ([...selected].some((source) => !['user', 'project', 'local'].includes(source))) {
    throw new Error('Native harness received unsupported --setting-sources');
  }
  return selected;
}

async function checkFile(
  file: string,
  readFile: typeof fs.readFile,
  checkRules: HarnessSettingsOptions['checkRules'],
): Promise<WorkerPermissions> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (missing(error)) {
      return {};
    }
    throw error;
  }
  try {
    return claudeSettingsRestrictions(JSON.parse(text), checkRules);
  } catch (error) {
    throw new Error(`Native harness settings admission failed for ${file}: ${String(error)}`);
  }
}

async function managedSettings(options: SettingsDiscovery): Promise<WorkerPermissions[]> {
  // Claude Code documents these file locations: macOS uses
  // /Library/Application Support/ClaudeCode, Linux and WSL use /etc/claude-code,
  // and Windows uses C:\Program Files\ClaudeCode (ProgramData is legacy and ignored).
  // WSL is therefore admitted through the Linux file source; Claude only consults
  // the Windows chain when its documented wslInheritsWindowsSettings controls are active.
  if (!['linux', 'darwin', 'win32'].includes(options.platform)) {
    throw new Error(`Native harness managed-policy admission does not support ${options.platform}`);
  }
  const platformPath = options.platform === 'win32' ? path.win32 : path.posix;
  const effectivePlatform =
    options.platform === 'linux' && /microsoft/i.test(options.osRelease)
      ? 'linux'
      : options.platform;
  let directory: string;
  if (effectivePlatform === 'darwin') {
    directory = '/Library/Application Support/ClaudeCode';
  } else if (effectivePlatform === 'win32') {
    directory = String.raw`C:\Program Files\ClaudeCode`;
  } else {
    directory = '/etc/claude-code';
  }
  const files = await managedPolicyFiles(options, platformPath, directory);
  const policies: WorkerPermissions[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = await options.readFile(file, 'utf8');
    } catch (error) {
      if (missing(error)) {
        continue;
      }
      throw error;
    }
    policies.push(managedPolicy(source, file, options.checkRules));
  }
  if (effectivePlatform === 'darwin') {
    policies.push(
      ...(await managedCommandPolicy(options, 'defaults', ['read', 'com.anthropic.claudecode'])),
    );
  } else if (effectivePlatform === 'win32') {
    policies.push(...(await managedRegistryPolicies(options)));
  }
  return policies;
}

async function managedPolicyFiles(
  options: SettingsDiscovery,
  platformPath: typeof path.posix,
  directory: string,
): Promise<string[]> {
  const files = [platformPath.join(directory, 'managed-settings.json')];
  try {
    const names = await options.readDir(platformPath.join(directory, 'managed-settings.d'));
    files.push(
      ...names
        .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
        .sort()
        .map((name) => platformPath.join(directory, 'managed-settings.d', name)),
    );
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
  }
  return files;
}

async function managedCommandPolicy(
  options: SettingsDiscovery,
  command: string,
  args: readonly string[],
  retry?: () => Promise<string | undefined>,
): Promise<WorkerPermissions[]> {
  let source: string | undefined;
  try {
    source = await options.runCommand(command, args);
  } catch (error) {
    if (managedPolicyCommandAbsent(command, error)) {
      return [];
    }
    if (!retry || !failedWithExitCode(error, 1)) {
      throw new Error(
        `Native harness cannot observe managed policy via ${command}: ${String(error)}`,
      );
    }
    source = await retry();
  }
  if (source === undefined || !source.trim()) {
    return [];
  }
  return [
    managedPolicy(parsePolicyValue(source), `${command} ${args.join(' ')}`, options.checkRules),
  ];
}

function managedPolicyCommandAbsent(command: string, error: unknown): boolean {
  if (!failedWithExitCode(error, 1) || !('stderr' in error)) {
    return false;
  }
  const stderr = String(error.stderr);
  if (command === 'defaults') {
    // macOS 27 reports a missing domain as "Domain '...' not found".
    return /does not exist|Domain .+ not found/i.test(stderr);
  }
  return command === 'reg' && /unable to find the specified registry key or value/i.test(stderr);
}

function failedWithExitCode(error: unknown, code: number): error is Error & { code: number } {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function managedRegistryPolicies(options: SettingsDiscovery): Promise<WorkerPermissions[]> {
  const policies: WorkerPermissions[] = [];
  for (const root of ['HKLM', 'HKCU']) {
    const key = `${root}\\SOFTWARE\\Policies\\ClaudeCode`;
    const source = await managedCommandPolicy(
      options,
      'reg',
      ['query', key, '/v', 'Settings'],
      () => managedRegistryValue(options, root),
    );
    policies.push(...source);
  }
  return policies;
}

// reg.exe exits 1 for an absent key, an absent value, and a denied read alike, and
// localizes its stderr in the OEM code page, so an unrecognized failure cannot be
// classified from text. PowerShell's error categories are locale-independent, so
// only that fallback distinguishes absence from a real failure; English machines
// never reach it.
async function managedRegistryValue(
  options: SettingsDiscovery,
  root: string,
): Promise<string | undefined> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `try { $key = Get-Item -LiteralPath '${root}:\\SOFTWARE\\Policies\\ClaudeCode' }`,
    "catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { exit 3 }; throw }",
    "$value = $key.GetValue('Settings', $null)",
    'if ($null -eq $value) { exit 3 }',
    '[Console]::Out.Write([string]$value)',
  ].join('\n');
  try {
    return await options.runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
  } catch (error) {
    if (failedWithExitCode(error, 3)) {
      return undefined;
    }
    throw new Error(
      `Native harness cannot observe managed policy via reg or PowerShell for ${root}: ${String(error)}`,
    );
  }
}

function parsePolicyValue(source: string): string {
  const trimmed = source.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    const match = trimmed.match(/(?:Settings\s+REG_(?:SZ|EXPAND_SZ)\s+)(.+)$/im);
    if (!match) {
      throw new Error('Native harness cannot parse managed policy output as JSON');
    }
    const value = match[1].trim();
    JSON.parse(value);
    return value;
  }
}

function managedPolicy(
  source: string,
  file: string,
  checkRules: HarnessSettingsOptions['checkRules'],
): WorkerPermissions {
  const settings = JSON.parse(source.trim() || '{}');
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    Object.keys(settings).some((key) => !['permissions', 'hooks', 'sandbox'].includes(key))
  ) {
    throw new Error(`Native harness cannot enforce managed policy ${file}; unsupported settings.`);
  }
  if (
    settings.permissions &&
    Object.keys(settings.permissions).some(
      (key) => !['allow', 'deny', 'ask', 'defaultMode'].includes(key),
    )
  ) {
    throw new Error(`Native harness cannot enforce managed permission controls in ${file}`);
  }
  return claudeSettingsRestrictions(settings, checkRules);
}

/** Claude cannot enforce these restrictions over tools a native harness executes. */
function claudeSettingsRestrictions(
  settings: unknown,
  checkRules: HarnessSettingsOptions['checkRules'],
): WorkerPermissions {
  const value = settingsRecord(settings);
  if (value.disableAllHooks === true) {
    throw new Error('Native harnesses require Claude mode hooks; disableAllHooks is unsupported.');
  }
  const permissions = settingsRecord(value.permissions ?? {});
  assertNativeAskRules(permissions.ask);
  const denied = permissions.deny;
  if (
    denied !== undefined &&
    (!Array.isArray(denied) || denied.some((rule) => typeof rule !== 'string'))
  ) {
    throw new Error('Native harnesses cannot enforce Claude permissions.deny');
  }
  checkRules?.(denied);
  // Claude's PreToolUse/PermissionRequest hooks never run for native harness tools.
  // They are not translatable policy, so they neither block admission nor apply.
  const sandbox = settingsRecord(value.sandbox ?? {});
  if (Object.keys(sandbox).some((key) => key !== 'enabled' || sandbox.enabled !== false)) {
    throw new Error(
      'Native harnesses cannot enforce Claude sandbox settings; native execution is unavailable.',
    );
  }
  return { disallowedTools: denied };
}

function settingsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Claude settings for native harness execution');
  }
  return value as Record<string, unknown>;
}

function assertNativeAskRules(value: unknown): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.length > 0 || value.some((rule) => typeof rule !== 'string'))
  ) {
    throw new Error(
      'Native harnesses cannot enforce Claude permissions.ask; native execution is unavailable.',
    );
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function toolRestriction(name: string, list: string[]): WorkerPermissions {
  if (name !== '--tools') {
    return { disallowedTools: list };
  }
  return list.includes('default') ? {} : { tools: list };
}

function toolArguments(value: string, args: readonly string[], start: number): [string[], number] {
  const values = [value];
  let index = start;
  while (index + 1 < args.length && !args[index + 1].startsWith('--')) {
    values.push(args[++index]);
  }
  return [values.flatMap((item) => item.split(/[ ,]+/).filter(Boolean)), index];
}

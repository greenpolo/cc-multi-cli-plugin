import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkerPermissions } from './agent-definitions.ts';
import { nativeToolRules } from './display-rows.ts';
import type { PermissionContext } from './mode-hook.ts';

// What a native harness run takes from the user's Claude settings. A harness runs its own
// tools, so only what it can enforce carries over: bare tool denials and tool lists. Anything
// else (ask rules, sandbox settings, argument-specific rules) is skipped and named in a
// one-line notice. Nothing here refuses a run.

export interface HarnessSettingsOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  osRelease?: string;
}

type SettingsDiscovery = Required<HarnessSettingsOptions>;

/** A bare tool name: the only kind of denial a native harness can enforce. */
const BARE_TOOL = /^[A-Za-z][\w-]*$/;

/**
 * A Claude MCP rule (`mcp__server`, `mcp__server__*`, `mcp__server__tool`). A harness with its
 * own MCP servers matches it against each MCP call; one without ignores it.
 */
const MCP_RULE = /^mcp__[\w-]+(__\*)?$/;

function nativeDenial(rule: string): boolean {
  return BARE_TOOL.test(rule) || MCP_RULE.test(rule);
}

const policyCommandTimeoutMs = 10_000;

/**
 * Policy probes run from fixed system directories: a bare name would let a
 * Windows working directory (searched first) or a user PATH entry answer for
 * the managed policy.
 */
function systemCommandPath(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
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

const runCommand = (
  options: SettingsDiscovery,
  command: string,
  args: readonly string[],
): Promise<string> =>
  new Promise((resolve, reject) => {
    childProcess.execFile(
      systemCommandPath(command, options.platform, options.env),
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

/** One sentence naming everything skipped, or none when everything carried over. */
function skippedNotice(skipped: ReadonlySet<string>): string | undefined {
  return skipped.size
    ? `Claude settings that do not apply to native runs were skipped: ${[...skipped].join(', ')}.`
    : undefined;
}

function joinNotices(...notices: (string | undefined)[]): string | undefined {
  const present = [...new Set(notices.filter((notice) => notice !== undefined))];
  return present.length ? present.join(' ') : undefined;
}

/** Restriction layers intersect grants and accumulate denials; none can widen another. */
export function mergePermissions(
  context: PermissionContext,
  rules: WorkerPermissions = {},
): PermissionContext {
  let tools = context.tools;
  if (rules.tools !== undefined) {
    tools = tools === undefined ? rules.tools : tools.filter((tool) => rules.tools?.includes(tool));
  }
  const notice = joinNotices(context.notice, rules.notice);
  return {
    ...context,
    tools,
    disallowedTools: [...(context.disallowedTools ?? []), ...(rules.disallowedTools ?? [])],
    ...(notice === undefined ? {} : { notice }),
  };
}

/**
 * A context's tool rules as a harness applies them. A scoped grant (`Bash(git:*)`) grants its
 * tool and a scoped denial denies nothing, because the scope has no native form; a rule for
 * a tool the harness does not have matches nothing. A display-row grant draws Claude Code
 * rows and maps to no native tool.
 */
export function nativeRules(context: Pick<PermissionContext, 'tools' | 'disallowedTools'>): {
  allowed?: Set<string>;
  denied: Set<string>;
} {
  const allowed = nativeToolRules(context.tools)?.map((tool) => tool.replace(/\(.*$/, ''));
  const denied = nativeToolRules(context.disallowedTools)?.filter(nativeDenial);
  return { allowed: allowed && new Set(allowed), denied: new Set(denied) };
}

/** The mode a native run uses for a Claude mode: only Plan and Bypass differ from Auto. */
export function nativeMode(mode: string | undefined): {
  mode: 'auto' | 'plan' | 'bypassPermissions';
  notice?: string;
} {
  if (mode === 'plan' || mode === 'bypassPermissions' || mode === 'auto') {
    return { mode };
  }
  if (mode === 'acceptEdits') {
    return { mode: 'auto' };
  }
  return {
    mode: 'auto',
    notice: `Claude's ${mode ?? 'current'} mode has no native equivalent; this run uses Auto.`,
  };
}

/** The managed policy is read once: it cannot change under a session, and reading it runs commands. */
const managedOnce = new Map<string, Promise<Layer[]>>();

/**
 * The tool restrictions a native run in `cwd` takes from Claude's settings. The settings
 * files are read on each call, so an edit applies to the next native run.
 */
export async function readHarnessSettings(
  cwd: string,
  args: readonly string[],
  inlineSettings: Record<string, unknown>,
  options: HarnessSettingsOptions = {},
): Promise<WorkerPermissions> {
  const discovery: SettingsDiscovery = {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    osRelease: options.osRelease ?? os.release(),
  };
  const skipped = new Set<string>();
  const { sources, restrictions } = settingSources(args, skipped);
  let managed = managedOnce.get(discovery.platform);
  if (!managed) {
    managed = managedSettings(discovery);
    managedOnce.set(discovery.platform, managed);
  }
  const layers: Layer[] = [
    ...(await managed),
    settingsLayer(inlineSettings),
    ...(await fileLayers(cwd, sources, discovery.env)),
  ];
  let context = mergePermissions({ permissionMode: 'auto' }, restrictions);
  for (const layer of layers) {
    context = mergePermissions(context, { disallowedTools: layer.denied });
    for (const item of layer.skipped) {
      skipped.add(item);
    }
  }
  const notice = skippedNotice(skipped);
  return {
    tools: context.tools,
    disallowedTools: context.disallowedTools,
    ...(notice === undefined ? {} : { notice }),
  };
}

/** The user, project and local settings files Claude Code reads for `cwd`, as selected. */
async function fileLayers(
  cwd: string,
  sources: ReadonlySet<string>,
  env: NodeJS.ProcessEnv,
): Promise<Layer[]> {
  const files: string[] = [];
  if (sources.has('user')) {
    const directory = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    files.push(path.join(directory, 'settings.json'));
  }
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    if (sources.has('project')) {
      files.push(path.join(directory, '.claude', 'settings.json'));
    }
    if (sources.has('local')) {
      files.push(path.join(directory, '.claude', 'settings.local.json'));
    }
    if (directory === path.dirname(directory)) {
      break;
    }
  }
  return Promise.all(files.map(fileLayer));
}

/** What one settings source contributes: the tools it denies outright, and what it held besides. */
interface Layer {
  denied: string[];
  skipped: string[];
}

const UNREADABLE: Layer = { denied: [], skipped: ['a settings source that could not be read'] };

function settingSources(
  args: readonly string[],
  skipped: Set<string>,
): { sources: Set<string>; restrictions: WorkerPermissions } {
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
    if (value === undefined || value.startsWith('--')) {
      // Claude Code reports its own argument errors; nothing to translate here.
      continue;
    }
    if (name === '--setting-sources') {
      sources = value;
    } else {
      const [list, lastIndex] = toolArguments(value, args, index);
      index = lastIndex;
      context = mergePermissions(context, toolRestriction(name, list, skipped));
    }
  }
  return { sources: new Set(sources.split(',').filter(Boolean)), restrictions: context };
}

async function fileLayer(file: string): Promise<Layer> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    return missing(error) ? { denied: [], skipped: [] } : UNREADABLE;
  }
  try {
    return settingsLayer(JSON.parse(text));
  } catch {
    // Claude Code reports an invalid settings file itself.
    return UNREADABLE;
  }
}

async function managedSettings(options: SettingsDiscovery): Promise<Layer[]> {
  // Claude Code documents these file locations: macOS uses
  // /Library/Application Support/ClaudeCode, Linux and WSL use /etc/claude-code,
  // and Windows uses C:\Program Files\ClaudeCode (ProgramData is legacy and ignored).
  const platformPath = options.platform === 'win32' ? path.win32 : path.posix;
  let directory = '/etc/claude-code';
  if (options.platform === 'darwin') {
    directory = '/Library/Application Support/ClaudeCode';
  } else if (options.platform === 'win32') {
    directory = String.raw`C:\Program Files\ClaudeCode`;
  }
  const layers: Layer[] = [];
  for (const file of await managedPolicyFiles(platformPath, directory)) {
    layers.push(await fileLayer(file));
  }
  try {
    if (options.platform === 'darwin') {
      layers.push(
        ...(await managedCommandPolicy(options, 'defaults', ['read', 'com.anthropic.claudecode'])),
      );
    } else if (options.platform === 'win32') {
      layers.push(...(await managedRegistryPolicies(options)));
    }
  } catch {
    layers.push(UNREADABLE);
  }
  return layers;
}

async function managedPolicyFiles(
  platformPath: typeof path.posix,
  directory: string,
): Promise<string[]> {
  const files = [platformPath.join(directory, 'managed-settings.json')];
  try {
    const names = await fs.readdir(platformPath.join(directory, 'managed-settings.d'));
    files.push(
      ...names
        .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
        .sort()
        .map((name) => platformPath.join(directory, 'managed-settings.d', name)),
    );
  } catch {
    // No drop-in directory, or one that cannot be listed: the main file is all there is.
  }
  return files;
}

async function managedCommandPolicy(
  options: SettingsDiscovery,
  command: string,
  args: readonly string[],
  retry?: () => Promise<string | undefined>,
): Promise<Layer[]> {
  let source: string | undefined;
  try {
    source = await runCommand(options, command, args);
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
  return [settingsLayer(JSON.parse(parsePolicyValue(source)))];
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

async function managedRegistryPolicies(options: SettingsDiscovery): Promise<Layer[]> {
  const policies: Layer[] = [];
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
    return await runCommand(options, 'powershell.exe', [
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Bare and MCP denials carry over; the rest is named. */
function bareRules(rules: unknown, skipped: string[] | Set<string>): string[] {
  const kept: string[] = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (typeof rule !== 'string') {
      continue;
    }
    if (nativeDenial(rule)) {
      kept.push(rule);
    } else if (Array.isArray(skipped)) {
      skipped.push('argument-specific deny rules');
    } else {
      skipped.add('argument-specific deny rules');
    }
  }
  return kept;
}

function settingsLayer(settings: unknown): Layer {
  const value = record(settings);
  const permissions = record(value.permissions);
  const skipped: string[] = [];
  if (Array.isArray(permissions.ask) && permissions.ask.length) {
    skipped.push('ask rules');
  }
  const sandbox = record(value.sandbox);
  if (sandbox.enabled === true) {
    skipped.push('sandbox settings');
  }
  return { denied: bareRules(permissions.deny, skipped), skipped };
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function toolRestriction(name: string, list: string[], skipped: Set<string>): WorkerPermissions {
  if (name !== '--tools') {
    return { disallowedTools: bareRules(list, skipped) };
  }
  // A scoped grant (`Bash(git:*)`) still grants its tool; the scope has no native form.
  return list.includes('default') ? {} : { tools: list.map((tool) => tool.replace(/\(.*$/, '')) };
}

function toolArguments(value: string, args: readonly string[], start: number): [string[], number] {
  const values = [value];
  let index = start;
  while (index + 1 < args.length && !args[index + 1].startsWith('--')) {
    values.push(args[++index]);
  }
  return [values.flatMap((item) => item.split(/[ ,]+/).filter(Boolean)), index];
}

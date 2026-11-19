// What the launcher asks of the Claude Code executable itself: its version, its login,
// the arguments it is started with, and the mod's start acknowledgement.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { type PluginPermissionInventory, pluginPermissions } from '../gateway/agent-definitions.ts';
import { executableInvocation, resolveExecutable } from '../gateway/executable.ts';

export const claudeExecutable = process.env.MULTI_REAL_CLAUDE;

export function validateSessionLaunch(args: string[]) {
  if (
    args.some((arg) => arg === '--bg' || arg === '--background') ||
    ['attach', 'respawn'].includes(args[0] ?? '')
  ) {
    // The background supervisor does not carry the gateway environment or --agents.
    throw new Error(
      'Multi sessions must stay attached to their launcher. Exit and use --resume <session-id> to continue with a fresh gateway; whole-session background handoff is unsupported.',
    );
  }
  if (args.some((arg) => arg === '--agents' || arg.startsWith('--agents='))) {
    throw new Error('This launcher supplies --agents; use agent files for additional agents.');
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function failedAuthProbeOutput(error: unknown): string {
  const details = recordValue(error);
  const code = details?.code;
  const stdout = details?.stdout;
  if (code === 1 && typeof stdout === 'string') {
    return stdout;
  }
  throw new Error('Claude auth status probe failed; cannot determine login state');
}

function parseAuthProbeOutput(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Claude auth status probe returned invalid JSON');
  }
  const details = recordValue(parsed);
  if (!details || typeof details.loggedIn !== 'boolean') {
    throw new Error('Claude auth status probe returned no boolean loggedIn field');
  }
  return details.loggedIn;
}

export async function assertFunctionHooksSupported(): Promise<void> {
  let stdout: string;
  let executable = 'claude';
  try {
    executable = resolveExecutable('claude', {
      platform: process.platform,
      env: process.env,
      configuredPath: claudeExecutable,
    });
    const invocation = executableInvocation(
      executable,
      ['--version'],
      process.platform,
      process.env,
    );
    ({ stdout } = await promisify(execFile)(invocation.command, invocation.args, {
      timeout: 10000,
      maxBuffer: 65536,
      ...invocation.options,
    }));
  } catch (error) {
    const details = recordValue(error);
    const code = typeof details?.code === 'string' ? ` (${details.code})` : '';
    const firstLine = String(error).split('\n', 1)[0];
    throw new Error(
      `Claude Code 2.1.272 or newer with function hooks is required; unable to read ${executable} --version${code}: ${firstLine}.`,
      { cause: error },
    );
  }
  const match = stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match || !atLeastVersion(match.slice(1).map(Number), [2, 1, 272])) {
    throw new Error('Claude Code 2.1.272 or newer with function hooks is required.');
  }
}

function claudeCommand(args: readonly string[]) {
  const environment = process.env;
  return executableInvocation(
    resolveExecutable('claude', {
      platform: process.platform,
      env: environment,
      configuredPath: claudeExecutable,
    }),
    args,
    process.platform,
    environment,
  );
}

function atLeastVersion(actual: number[], required: number[]): boolean {
  for (let index = 0; index < required.length; index++) {
    const received = actual[index] ?? 0;
    const minimum = required[index] ?? 0;
    if (received !== minimum) {
      return received > minimum;
    }
  }
  return true;
}

/**
 * Claude Code has to start, load the plugin worker and run session.start before
 * the mod can acknowledge. A cold start on Windows takes well over five seconds
 * (large binary, antivirus scan), so the wait is generous and overridable.
 */
const modSessionStartTimeoutMs = Number(process.env.MULTI_MOD_START_TIMEOUT_MS ?? 30000);

/**
 * Wait for the mod's acknowledgement, or for a Claude that exits first: that ends the
 * launch with Claude's own exit code. A timeout is the launcher's error.
 */
export async function awaitStartOrExit(
  modStart: { ready: Promise<void>; cancel: () => void },
  exited: Promise<number>,
  child: { kill: () => boolean },
  shutdown: () => Promise<void>,
) {
  try {
    const earlyExit = await Promise.race([modStart.ready.then(() => undefined), exited]);
    if (earlyExit !== undefined) {
      modStart.cancel();
      await shutdown();
      process.exit(earlyExit);
    }
  } catch (error) {
    child.kill();
    await shutdown();
    throw error;
  }
}

export function awaitModSessionStart(): { ready: Promise<void>; cancel: () => void } {
  let cancel = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('multi-mod-session-start', acknowledged);
      reject(
        new Error(
          'Claude Code 2.1.272 or newer with loaded function hooks is required; the Multi mod did not acknowledge session.start.',
        ),
      );
    }, modSessionStartTimeoutMs);
    const acknowledged = () => {
      clearTimeout(timer);
      resolve();
    };
    cancel = () => {
      clearTimeout(timer);
      process.off('multi-mod-session-start', acknowledged);
    };
    process.once('multi-mod-session-start', acknowledged);
  });
  // A cancelled wait never settles; a timed-out one is handled by whoever awaits it.
  ready.catch(() => {});
  return { ready, cancel };
}

export async function anthropicSignedIn(): Promise<boolean> {
  // Ask Claude, including its OS credential store and configured helpers. Never read its tokens.
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return true;
  }
  let stdout: string;
  try {
    const invocation = claudeCommand(['auth', 'status', '--json']);
    ({ stdout } = await promisify(execFile)(invocation.command, invocation.args, {
      timeout: 10000,
      maxBuffer: 65536,
      ...invocation.options,
    }));
  } catch (error) {
    stdout = failedAuthProbeOutput(error);
  }
  return parseAuthProbeOutput(stdout);
}

/** A plugin inventory that cannot be read means no plugin workers, not no session. */
export async function pluginInventoryOrEmpty(cwd: string, args: readonly string[]) {
  try {
    return await pluginPermissions(cwd, args);
  } catch (error) {
    process.stderr.write(
      `Multi: could not list Claude plugins (${error instanceof Error ? error.message.split('\n', 1)[0] : String(error)}); plugin-provided workers are unavailable.\n`,
    );
    return { permissions: {}, multiCoreEnabled: false } satisfies PluginPermissionInventory;
  }
}

export async function findPluginRoot(file: string): Promise<string> {
  for (let directory = path.dirname(path.resolve(file)); ; directory = path.dirname(directory)) {
    try {
      await stat(path.join(directory, '.claude-plugin', 'plugin.json'));
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new Error(`Could not find the Multi plugin root above ${file}`);
      }
    }
  }
}

function hasPluginDirectory(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--plugin-dir' || arg.startsWith('--plugin-dir='));
}

export function launcherArguments(
  args: readonly string[],
  settingsFile: string,
  definitions: string,
  inventory: PluginPermissionInventory,
  pluginRoot: string,
): string[] {
  const pluginDirectory =
    !hasPluginDirectory(args) && (!inventory.multiCoreEnabled || hasEmptySettingSources(args))
      ? ['--plugin-dir', pluginRoot]
      : [];
  return ['--settings', settingsFile, '--agents', definitions, ...args, ...pluginDirectory];
}

function hasEmptySettingSources(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--setting-sources' && args[index + 1] === '') {
      return true;
    }
    if (arg === '--setting-sources=') {
      return true;
    }
  }
  return false;
}

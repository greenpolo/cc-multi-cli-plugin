import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../../multi-core/src/gateway/atomic-write.ts';
import { hookCommand } from '../../multi-core/src/gateway/permission-hook.ts';
import { lockStateFile } from '../../multi-core/src/gateway/state-lock.ts';

const namespace = 'multi-cli-antigravity';
/** Long enough for a concurrent launch's read and atomic rewrite of the hook file. */
const hookLockWaitMs = 5000;

export interface AntigravityPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

function configRoot(options: AntigravityPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA ?? env.APPDATA ?? join(home, 'AppData', 'Local'), 'gemini');
  }
  return join(home, '.gemini');
}

export function antigravityHookFile(options: AntigravityPathOptions = {}): string {
  const join =
    (options.platform ?? process.platform) === 'win32' ? path.win32.join : path.posix.join;
  return join(configRoot(options), 'config', 'hooks.json');
}

export function antigravitySettingsFile(options: AntigravityPathOptions = {}): string {
  const join =
    (options.platform ?? process.platform) === 'win32' ? path.win32.join : path.posix.join;
  return join(configRoot(options), 'antigravity-cli', 'settings.json');
}

/**
 * The hook is global to every agy run on this machine. On POSIX hosts agy runs
 * the command through a shell, so a cheap parameter-expansion guard skips the
 * Node start-up unless a gateway policy is present. Windows shells cannot be
 * assumed, so the hook invokes Node directly and the hook itself stays neutral
 * without a policy.
 */
export function antigravityHookDefinition(platform: NodeJS.Platform = process.platform) {
  const command = hookCommand(new URL('./permission-hook.ts', import.meta.url), platform);
  return {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command:
              platform === 'win32'
                ? command
                : `if [ "\${MULTI_ANTIGRAVITY_DENY+x}" = x ]; then ${command}; fi`,
            timeout: 10,
          },
        ],
      },
    ],
  };
}

async function readHooks(file: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid Antigravity hooks file');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

/** Install one stable hook; each originating CLI process carries its own policy. */
export async function installAntigravityHook(
  file = antigravityHookFile(),
  options: AntigravityPathOptions = {},
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // Every launch reinstalls the hook, so a concurrent launch holds this briefly.
  const unlock = await lockStateFile(`${file}.multi-lock`, { waitMs: hookLockWaitMs });
  try {
    const hooks = await readHooks(file);
    const platform = options.platform ?? process.platform;
    hooks[namespace] = antigravityHookDefinition(platform);
    await atomicWriteFile(file, `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600, platform });
  } finally {
    await unlock();
  }
}

export async function checkAntigravityHooks(
  files: {
    globalFile?: string;
    settingsFile?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homedir?: string;
  } = {},
): Promise<void> {
  const options = files;
  assertAntigravityHooks(
    await readHooks(files.globalFile ?? antigravityHookFile(options)),
    options.platform ?? process.platform,
  );
  const settings = await readHooks(files.settingsFile ?? antigravitySettingsFile(options));
  if (settings.modelProvider !== undefined || settings.customModels !== undefined) {
    throw new Error(
      'Antigravity requires native account authentication and models; custom provider settings are unsupported.',
    );
  }
}

function assertAntigravityHooks(hooks: Record<string, unknown>, platform: NodeJS.Platform): void {
  if (JSON.stringify(hooks[namespace]) !== JSON.stringify(antigravityHookDefinition(platform))) {
    throw new Error(
      'Antigravity requires its native permission hook. Run the launcher with --antigravity-setup.',
    );
  }
}

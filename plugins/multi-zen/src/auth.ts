import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isRecord } from '../../multi-core/src/gateway/record.ts';

class ZenAuthError extends Error {}

export function validateZenKey(value: string): string {
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw new ZenAuthError('Invalid OpenCode Zen API key.');
  }
  return value;
}

function pathForPlatform(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export interface ZenAuthPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

/**
 * OpenCode's auth stores, preferred first. OpenCode 1.1 and newer use the XDG data
 * home on every platform, so Windows keeps `~\.local\share\opencode` and falls back
 * to the older `%LOCALAPPDATA%\opencode`. `OPENCODE_AUTH_FILE` overrides both.
 */
function zenAuthFiles({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
}: ZenAuthPathOptions = {}): [string, ...string[]] {
  const explicit = env.OPENCODE_AUTH_FILE;
  if (explicit) {
    return [explicit];
  }
  const pathApi = pathForPlatform(platform);
  const xdg = pathApi.join(
    env.XDG_DATA_HOME || pathApi.join(homedir, '.local', 'share'),
    'opencode',
    'auth.json',
  );
  if (platform !== 'win32') {
    return [xdg];
  }
  const legacy = pathApi.join(
    env.LOCALAPPDATA || pathApi.join(homedir, 'AppData', 'Local'),
    'opencode',
    'auth.json',
  );
  return xdg === legacy ? [xdg] : [xdg, legacy];
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** The first auth store that exists, with its text; undefined when none does. */
async function existingAuthFile(
  options: ZenAuthPathOptions,
): Promise<{ file: string; source: string } | undefined> {
  for (const file of zenAuthFiles(options)) {
    try {
      return { file, source: await readFile(file, 'utf8') };
    } catch (error) {
      if (!isMissing(error)) {
        throw new ZenAuthError('Cannot read OpenCode auth.json.');
      }
    }
  }
  return undefined;
}

/** The auth store a key is read from or saved to: the first that exists, else the preferred one. */
async function zenAuthFile(options: ZenAuthPathOptions = {}): Promise<string> {
  const existing = await existingAuthFile(options).catch(() => undefined);
  return existing?.file ?? zenAuthFiles(options)[0];
}

/** Read only the OpenCode Zen API key; credentials stay owned by OpenCode. */
export async function readZenKey(options: ZenAuthPathOptions = {}): Promise<string | undefined> {
  const configured = (options.env ?? process.env).OPENCODE_API_KEY;
  if (configured !== undefined) {
    return validateZenKey(configured);
  }

  const existing = await existingAuthFile(options);
  if (!existing) {
    return undefined;
  }
  const { source } = existing;

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new ZenAuthError('OpenCode auth.json is invalid.');
  }
  if (!isRecord(parsed) || parsed.opencode === undefined) {
    return undefined;
  }
  const entry = parsed.opencode;
  if (
    !isRecord(entry) ||
    entry.type !== 'api' ||
    typeof entry.key !== 'string' ||
    !entry.key.trim()
  ) {
    throw new ZenAuthError('OpenCode auth.json has invalid Zen API credentials.');
  }
  return validateZenKey(entry.key);
}

/** Persist local key entry in OpenCode's existing auth store, preserving other providers. */
export async function saveZenKey(key: string, options: ZenAuthPathOptions = {}): Promise<void> {
  const validated = validateZenKey(key);
  const platform = options.platform ?? process.platform;
  const pathApi = pathForPlatform(platform);
  const file = await zenAuthFile(options);
  let entries: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(parsed)) {
      throw new ZenAuthError('OpenCode auth.json is invalid.');
    }
    entries = parsed;
  } catch (error) {
    if (!isMissing(error)) {
      throw new ZenAuthError(
        'Cannot update OpenCode auth.json. Existing credentials were preserved.',
      );
    }
  }
  await mkdir(pathApi.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = pathApi.join(
    pathApi.dirname(file),
    `${pathApi.basename(file)}.multi-${process.pid}.tmp`,
  );
  await writeFile(
    temporary,
    `${JSON.stringify({ ...entries, opencode: { type: 'api', key: validated } }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await rename(temporary, file);
}

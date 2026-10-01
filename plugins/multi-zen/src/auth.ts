import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isRecord } from '../../multi-core/src/gateway/record.ts';

export class ZenAuthError extends Error {}

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

export function zenAuthFile({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
}: ZenAuthPathOptions = {}): string {
  const explicit = env.OPENCODE_AUTH_FILE;
  if (explicit) {
    return explicit;
  }
  const pathApi = pathForPlatform(platform);
  const dataHome =
    platform === 'win32'
      ? env.LOCALAPPDATA || pathApi.join(homedir, 'AppData', 'Local')
      : env.XDG_DATA_HOME || pathApi.join(homedir, '.local', 'share');
  return pathApi.join(dataHome, 'opencode', 'auth.json');
}

/** Read only the OpenCode Zen API key; credentials stay owned by OpenCode. */
export async function readZenKey(options: ZenAuthPathOptions = {}): Promise<string | undefined> {
  const configured = (options.env ?? process.env).OPENCODE_API_KEY;
  if (configured !== undefined) {
    return validateZenKey(configured);
  }

  let source: string;
  try {
    source = await readFile(zenAuthFile(options), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw new ZenAuthError('Cannot read OpenCode auth.json.');
  }

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
  const file = zenAuthFile(options);
  let entries: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(parsed)) {
      throw new ZenAuthError('OpenCode auth.json is invalid.');
    }
    entries = parsed;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
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

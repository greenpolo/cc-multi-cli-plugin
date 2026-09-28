import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ExecutableOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  configuredPath?: string;
  exists?: (filename: string) => boolean;
}

export interface ExecutableInvocation {
  command: string;
  args: string[];
  viaComSpec: boolean;
  options?: { windowsVerbatimArguments?: boolean };
}

export interface ExecutableInvocationOptions {
  readShim?: (filename: string) => string;
  exists?: (filename: string) => boolean;
}

/** Find a configured executable or a platform-appropriate PATH entry. */
/**
 * Windows environment names are case-insensitive and the real variable is
 * usually spelled `Path`. A plain object built by spreading `process.env`
 * keeps that spelling, so look the name up without regard to case.
 */
function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) {
    return env[name];
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

export function resolveExecutable(name: string, options: ExecutableOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const configured = options.configuredPath;
  if (configured) {
    if (exists(configured)) {
      return configured;
    }
    throw missingExecutable(`Configured executable does not exist: ${configured}`);
  }
  const candidates =
    platform === 'win32' ? windowsCandidates(name, environmentValue(env, 'PATHEXT')) : [name];
  const found = findOnPath(
    environmentValue(env, 'PATH') ?? '',
    candidates,
    exists,
    platform === 'win32' ? ';' : path.delimiter,
    platform === 'win32' ? path.win32 : path,
  );
  if (found) {
    return found;
  }
  throw missingExecutable(`Executable not found on PATH: ${name}`);
}

function missingExecutable(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

/** Invoke Windows command shims without shell:true, preserving argument boundaries. */
export function executableInvocation(
  executable: string,
  args: readonly string[],
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  shimOptions: ExecutableInvocationOptions = {},
): ExecutableInvocation {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { command: executable, args: [...args], viaComSpec: false };
  }
  const shimTarget = resolveNpmShimTarget(executable, shimOptions);
  if (shimTarget) {
    return {
      command: process.execPath,
      args: [shimTarget, ...args],
      viaComSpec: false,
    };
  }
  const command = environmentValue(env, 'ComSpec') ?? process.env.ComSpec ?? 'cmd.exe';
  const commandLine = [quoteWindows(executable), ...args.map(quoteWindows)].join(' ');
  return {
    command,
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    viaComSpec: true,
    options: { windowsVerbatimArguments: true },
  };
}

const MAX_SHIM_SIZE = 32 * 1024;
const SHIM_TARGET = /"%dp0%\\([^"\r\n]+\.(?:js|cjs|mjs))"[ \t]+%\*/gi;

function resolveNpmShimTarget(
  executable: string,
  options: ExecutableInvocationOptions,
): string | undefined {
  const readShim = options.readShim ?? ((filename: string) => readFileSync(filename, 'utf8'));
  const exists = options.exists ?? existsSync;
  let contents: string;
  try {
    contents = readShim(executable);
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(contents, 'utf8') > MAX_SHIM_SIZE) {
    return undefined;
  }
  const matches = [...contents.matchAll(SHIM_TARGET)];
  if (matches.length !== 1) {
    return undefined;
  }
  const relativeTarget = matches[0]?.[1];
  if (!relativeTarget || path.win32.isAbsolute(relativeTarget)) {
    return undefined;
  }
  const target = path.win32.resolve(path.win32.dirname(executable), relativeTarget);
  return exists(target) ? target : undefined;
}

function findOnPath(
  pathValue: string,
  candidates: readonly string[],
  exists: (filename: string) => boolean,
  delimiter: string,
  pathModule: typeof path,
): string | undefined {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const filename = pathModule.join(directory, candidate);
      if (exists(filename)) {
        return filename;
      }
    }
  }
  return undefined;
}

function windowsCandidates(name: string, pathext: string | undefined): string[] {
  if (path.extname(name)) {
    return [name];
  }
  const extensions = (pathext ?? '.COM;.EXE;.BAT;.CMD').split(';');
  return [...extensions, ''].map((extension) => `${name}${extension.toLowerCase()}`);
}

function quoteWindows(value: string): string {
  // An unquoted empty argument vanishes from the command line, shifting later values.
  if (value && !/[\s"&()^|<>]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

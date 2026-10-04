import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';

export interface LockStateFileOptions {
  /** Exclusive re-creation of a marker that was moved aside by mistake. */
  link?: typeof link;
  /** Stable machine identity; defaults to the OS-provided id when one exists. */
  machineId?: string | undefined;
  hostname?: string;
  platform?: NodeJS.Platform;
  maxAttempts?: number;
  /**
   * How long to wait for a live owner to release before failing. The default 0
   * fails at once: a session file held by another gateway is owned, not busy.
   */
  waitMs?: number;
  rename?: typeof rename;
  unlink?: typeof unlink;
  open?: typeof open;
  lstat?: typeof lstat;
  readFile?: typeof readFile;
}

const lockOperationAttempts = 5;

interface LockOwner {
  pid: number;
  hostname: string;
  token: string;
  /** OS machine identity that survives a hostname change (absent in older markers). */
  machine?: string;
}

let cachedMachineId: { value: string | undefined } | undefined;

/**
 * A hostname follows the network (macOS flips between `.local`, `.lan` and
 * conflict suffixes), so identity prefers an OS machine id when one is readable.
 */
export function machineIdentity(platform: NodeJS.Platform = process.platform): string | undefined {
  if (cachedMachineId) {
    return cachedMachineId.value;
  }
  let value: string | undefined;
  try {
    if (platform === 'linux') {
      value = readFileSync('/etc/machine-id', 'utf8').trim() || undefined;
    } else if (platform === 'darwin') {
      const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      value = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output)?.[1];
    }
  } catch {
    value = undefined;
  }
  cachedMachineId = { value };
  return value;
}

/** Lower-cased first label: `Mac.local`, `mac.lan` and `MAC` are one machine name. */
export function normalizeHostname(name: string): string {
  return name.toLowerCase().split('.')[0] ?? '';
}

/** Whether a marker was written by this machine, tolerating hostname drift. */
export function sameMachine(
  recorded: LockOwner,
  self: { hostname: string; machine?: string | undefined },
): boolean {
  if (recorded.machine !== undefined && self.machine !== undefined) {
    return recorded.machine === self.machine;
  }
  return normalizeHostname(recorded.hostname) === normalizeHostname(self.hostname);
}

function newOwner(options: LockStateFileOptions, platform: NodeJS.Platform): LockOwner {
  const machine = 'machineId' in options ? options.machineId : machineIdentity(platform);
  return {
    pid: process.pid,
    hostname: options.hostname ?? hostname(),
    token: randomUUID(),
    ...(machine === undefined ? {} : { machine }),
  };
}

/**
 * Acquire a process lock using an exclusive marker file.
 *
 * The marker remains when its process is killed, so the next owner checks the
 * recorded PID and atomically moves a stale marker aside before retrying. A
 * PID can be reused after a process dies; the metadata therefore includes a
 * token for safe release, but cannot completely eliminate that operating
 * system limitation. The lock is intended to serialize native state updates,
 * not to provide a durable lease across PID reuse.
 */
export async function lockStateFile(
  file: string,
  options: LockStateFileOptions = {},
): Promise<() => Promise<void>> {
  const platform = options.platform ?? process.platform;
  const owner = newOwner(options, platform);
  const maxAttempts = options.maxAttempts ?? 100;
  const openFile = options.open ?? open;
  const operations = lockOperations(options);
  const { unlinkFile, readFileContents } = operations;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('State file lock maxAttempts must be a positive integer');
  }
  const deadline = Date.now() + (options.waitMs ?? 0);

  for (let attempt = 0; attempt < maxAttempts; ) {
    const release = await tryAcquire(file, owner, platform, unlinkFile, openFile, readFileContents);
    if (release) {
      return release;
    }
    if (await ownerStillHolds(file, owner, platform, operations, deadline)) {
      continue;
    }
    attempt += 1;
    if (platform === 'win32') {
      await delay(20);
    }
  }
  throw new Error(`State file lock acquisition exceeded ${maxAttempts} attempts`);
}

function lockOperations(options: LockStateFileOptions): LockOperations {
  return {
    renameFile: options.rename ?? rename,
    unlinkFile: options.unlink ?? unlink,
    lstatFile: options.lstat ?? lstat,
    readFileContents: options.readFile ?? readFile,
    linkFile: options.link ?? link,
  };
}

class LockHeld extends Error {}

const ownerPollMs = 50;

/**
 * Takes over a stale marker; a live owner's marker is waited on until `deadline`,
 * then refused. True when the caller should try again without spending an attempt.
 */
async function ownerStillHolds(
  file: string,
  owner: LockOwner,
  platform: NodeJS.Platform,
  operations: LockOperations,
  deadline: number,
): Promise<boolean> {
  try {
    await takeOverStaleLock(file, owner, platform, operations);
    return false;
  } catch (error) {
    if (!(error instanceof LockHeld) || Date.now() >= deadline) {
      throw error;
    }
    await delay(Math.min(ownerPollMs, Math.max(1, deadline - Date.now())));
    return true;
  }
}

async function tryAcquire(
  file: string,
  owner: LockOwner,
  platform: NodeJS.Platform,
  unlinkFile: typeof unlink,
  openFile: typeof open,
  readFileContents: typeof readFile,
): Promise<(() => Promise<void>) | undefined> {
  const descriptor = await openLock(file, openFile);
  if (!descriptor) {
    return undefined;
  }
  try {
    await descriptor.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
  } finally {
    await descriptor.close();
  }
  return () => releaseLock(file, owner, platform, unlinkFile, readFileContents);
}

async function openLock(file: string, openFile: typeof open) {
  try {
    return await openFile(file, 'wx', 0o600);
  } catch (error) {
    if (isCode(error, 'EEXIST')) {
      return undefined;
    }
    if (isCode(error, 'EISDIR')) {
      throw legacyLockError();
    }
    throw error;
  }
}

interface LockOperations {
  renameFile: typeof rename;
  unlinkFile: typeof unlink;
  lstatFile: typeof lstat;
  readFileContents: typeof readFile;
  linkFile: typeof link;
}

async function takeOverStaleLock(
  file: string,
  self: LockOwner,
  platform: NodeJS.Platform,
  operations: LockOperations,
): Promise<void> {
  const { renameFile, unlinkFile, lstatFile, readFileContents, linkFile } = operations;
  const info = await lstatFile(file).catch((error: unknown) => {
    if (isCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  });
  if (!info) {
    return;
  }
  if (info.isDirectory()) {
    throw legacyLockError();
  }
  const current = await readOwner(file, platform, readFileContents);
  if (!current) {
    // The owner released between the lstat and the read: the caller acquires again.
    return;
  }
  if (
    current !== legacyEmptyMarker &&
    (!sameMachine(current, self) || isProcessAlive(current.pid))
  ) {
    throw new LockHeld('State file is locked by another gateway');
  }
  const stale = `${file}.stale-${randomUUID()}`;
  try {
    await retryLockOperation(() => renameFile(file, stale), platform, 'stale-lock takeover');
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return;
    }
    throw new Error('State file lock owner exited but stale-lock takeover failed', {
      cause: error,
    });
  }
  // Between our read and the rename another gateway may have taken over and
  // acquired; then the marker we moved is a live lock and must go back.
  const moved = await readOwner(stale, platform, readFileContents);
  if (!sameMarker(current, moved)) {
    await restoreMovedMarker(file, stale, platform, { linkFile, unlinkFile });
    return;
  }
  await retryLockOperation(() => unlinkFile(stale), platform, 'stale-lock cleanup').catch(
    (error: unknown) => {
      if (!isCode(error, 'ENOENT')) {
        throw error;
      }
    },
  );
}

function sameMarker(
  expected: LockOwner | typeof legacyEmptyMarker,
  actual: LockOwner | typeof legacyEmptyMarker | undefined,
): boolean {
  if (expected === legacyEmptyMarker || actual === legacyEmptyMarker) {
    return expected === actual;
  }
  return actual !== undefined && actual.token === expected.token;
}

/** `link` creates the marker only if none exists, so a newer owner is never clobbered. */
async function restoreMovedMarker(
  file: string,
  stale: string,
  platform: NodeJS.Platform,
  operations: Pick<LockOperations, 'linkFile' | 'unlinkFile'>,
): Promise<void> {
  try {
    await retryLockOperation(() => operations.linkFile(stale, file), platform, 'lock restore');
  } catch (error) {
    // Another gateway already re-acquired; the contested marker is stale-by-token.
    if (!(error instanceof Error && isCode(error.cause, 'EEXIST'))) {
      throw error;
    }
  }
  await operations.unlinkFile(stale).catch(() => {});
}

async function releaseLock(
  file: string,
  owner: LockOwner,
  platform: NodeJS.Platform,
  unlinkFile: typeof unlink,
  readFileContents: typeof readFile,
): Promise<void> {
  const current = await readOwner(file, platform, readFileContents);
  if (
    !current ||
    current === legacyEmptyMarker ||
    current.token !== owner.token ||
    !sameMachine(current, owner)
  ) {
    return;
  }
  await retryLockOperation(() => unlinkFile(file), platform, 'lock release').catch(
    (error: unknown) => {
      if (!isCode(error, 'ENOENT')) {
        throw error;
      }
    },
  );
}

async function retryLockOperation<T>(
  operation: () => Promise<T>,
  platform: NodeJS.Platform,
  description: string,
): Promise<T> {
  for (let attempt = 0; attempt < lockOperationAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable = platform === 'win32' && (isCode(error, 'EPERM') || isCode(error, 'EBUSY'));
      if (!retryable || attempt === lockOperationAttempts - 1) {
        throw new Error(
          `State file lock ${description} failed after ${lockOperationAttempts} attempts`,
          {
            cause: error,
          },
        );
      }
      await delay(20);
    }
  }
  throw new Error(`State file lock ${description} did not complete`);
}

/** Marker left by the pre-marker `flock` lock: it exists but never gets metadata. */
const legacyEmptyMarker = Symbol('legacy-empty-marker');

async function readOwner(
  file: string,
  platform: NodeJS.Platform,
  readFileContents: typeof readFile = readFile,
): Promise<LockOwner | typeof legacyEmptyMarker | undefined> {
  let lastParseError: SyntaxError | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const contents = await readFileContents(file, 'utf8');
      if (contents.trim() === '') {
        await delay(20);
        continue;
      }
      const value: unknown = JSON.parse(contents);
      if (!isLockOwner(value)) {
        throw new Error(`State file lock metadata is invalid on ${platform}`);
      }
      return value;
    } catch (error) {
      if (isCode(error, 'ENOENT')) {
        return undefined;
      }
      if (error instanceof SyntaxError) {
        lastParseError = error;
        await delay(20);
        continue;
      }
      throw error;
    }
  }
  if (lastParseError) {
    throw new Error(`State file lock metadata is invalid on ${platform}`, {
      cause: lastParseError,
    });
  }
  // Still empty after the write-race window: an earlier release used an empty
  // file held by `flock`, which nothing in this version can hold. Treat it as
  // stale so an upgrade never leaves the state permanently locked.
  return legacyEmptyMarker;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ESRCH' || error.code === 'EINVAL')
    ) {
      return false;
    }
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    throw error;
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === 'number' &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.hostname === 'string' &&
    typeof candidate.token === 'string'
  );
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function legacyLockError(): Error {
  return new Error('State file has a legacy interrupted lock; preserve it for manual recovery');
}

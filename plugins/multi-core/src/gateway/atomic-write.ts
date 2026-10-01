import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export async function atomicWriteFile(
  file: string,
  data: string | Uint8Array,
  options: {
    mode?: number;
    platform?: NodeJS.Platform;
    retries?: number;
    rename?: typeof rename;
    rm?: typeof rm;
    open?: typeof open;
  } = {},
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  // Windows sharing violations last as long as a concurrent reader holds the
  // file open; 50 paced attempts cover about a second of contention.
  const retries = options.retries ?? 50;
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new RangeError('Atomic write retries must be a non-negative integer');
  }
  const openFile = options.open ?? open;
  const attempts = options.platform === 'win32' ? retries : 0;
  const renameFile = options.rename ?? rename;
  const removeFile = options.rm ?? rm;
  try {
    await writeDurably(openFile, temporary, data, options.mode);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await renameFile(temporary, file);
        await syncDirectory(openFile, path.dirname(file), options.platform);
        return;
      } catch (error) {
        const retryable = isWindowsRenameRetryable(error, options.platform);
        if (!retryable || attempt >= attempts) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
  } finally {
    await removeFile(temporary, { force: true }).catch(() => {});
  }
}

function isWindowsRenameRetryable(error: unknown, platform: NodeJS.Platform | undefined) {
  return (
    platform === 'win32' &&
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EBUSY')
  );
}

/** Flush the bytes before the rename can make them visible under the final name. */
async function writeDurably(
  openFile: typeof open,
  file: string,
  data: string | Uint8Array,
  mode: number | undefined,
): Promise<void> {
  const handle = await openFile(file, 'w', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Persist the rename itself. Windows cannot open a directory for syncing, and
 * some POSIX filesystems refuse it, so this step is best effort by design.
 */
async function syncDirectory(
  openFile: typeof open,
  directory: string,
  platform: NodeJS.Platform | undefined,
): Promise<void> {
  if ((platform ?? process.platform) === 'win32') {
    return;
  }
  try {
    const handle = await openFile(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The data is already durable; only rename durability is unavailable here.
  }
}

import { spawn } from 'node:child_process';

export interface ProcessTreeOptions {
  platform?: NodeJS.Platform;
  signal?: NodeJS.Signals;
  kill?: (pid: number, signal?: NodeJS.Signals | number) => void;
  /** Windows only: `force` adds `/F`; without it the tree is asked to close. */
  taskkill?: (pid: number, force: boolean) => void;
  /** POSIX only: signal the group but never the bare PID (it may be reused). */
  groupOnly?: boolean;
}

/**
 * Stop a CLI and its descendants. POSIX group membership is best effort: a
 * child can leave the group, so the direct-PID fallback is always attempted.
 * Windows has no portable POSIX group signal, therefore taskkill owns the tree.
 * Only SIGKILL (or an unspecified signal, the historical behavior) forces; any
 * other signal asks politely so a CLI can still save state.
 */
export function terminateProcessTree(pid: number, options: ProcessTreeOptions = {}): void {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const force = options.signal === undefined || options.signal === 'SIGKILL';
    (options.taskkill ?? defaultTaskkill)(pid, force);
    return;
  }
  const kill = options.kill ?? process.kill;
  const signal = options.signal ?? 'SIGTERM';
  try {
    kill(-pid, signal);
  } catch {
    // The process may have exited, or the group may not exist.
  }
  if (options.groupOnly) {
    return;
  }
  try {
    kill(pid, signal);
  } catch {
    // The process may have exited between group and direct cleanup.
  }
}

function defaultTaskkill(pid: number, force: boolean): void {
  const child = spawn(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/c', 'taskkill', '/T', ...(force ? ['/F'] : []), '/PID', String(pid)],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.once('error', () => {});
}

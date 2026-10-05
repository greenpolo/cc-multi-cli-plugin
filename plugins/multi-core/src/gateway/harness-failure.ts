import { NativeCliError } from './harness-process.ts';
import { HarnessBusyError } from './harness-session.ts';

/**
 * A machine momentarily out of processes, file handles or memory starts the CLI
 * on the next attempt; a missing binary or a denied path never does.
 */
const TRANSIENT_SPAWN = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'ETXTBSY']);

/** Launch failures that arrive as plain errors, before a native run object exists. */
const PERMANENT_LAUNCH = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EUNSAFEARG']);

export type HarnessFailureClass = {
  /** The same request fails the same way again: retrying only repeats a paid attempt. */
  deterministic: boolean;
  /** 400 for deterministic and configuration failures, 502 for uncertain or transient ones. */
  status: 400 | 502;
};

function systemCodeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

/**
 * The one status policy for native CLI harnesses (Antigravity, Grok). A busy
 * agent, an unapplied permission policy, a missing or unrunnable binary and an
 * argument the platform cannot carry fail identically on every attempt, so they
 * are request errors. Everything else (a stream that ended without a result, a
 * crash, an output limit, a transient resource shortage) leaves the native run in
 * an uncertain state and stays 502 so the caller sees an interrupted turn.
 */
export function classifyHarnessFailure(error: unknown): HarnessFailureClass {
  if (error instanceof HarnessBusyError) {
    return { deterministic: true, status: 400 };
  }
  if (error instanceof NativeCliError && error.code === 'policy') {
    return { deterministic: true, status: 400 };
  }
  if (error instanceof NativeCliError) {
    const transient = TRANSIENT_SPAWN.has(error.systemCode ?? '');
    return error.code === 'spawn' && !transient
      ? { deterministic: true, status: 400 }
      : { deterministic: false, status: 502 };
  }
  if (PERMANENT_LAUNCH.has(systemCodeOf(error) ?? '')) {
    return { deterministic: true, status: 400 };
  }
  return { deterministic: false, status: 502 };
}

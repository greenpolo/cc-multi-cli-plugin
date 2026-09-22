import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  executableInvocation,
  resolveExecutable,
} from '../../multi-core/src/gateway/executable.ts';
import { terminateProcessTree } from '../../multi-core/src/gateway/process-tree.ts';

interface CodexQuotaWindow {
  label: string;
  usedPercent: number;
  resetsAt?: string;
}
export interface CodexQuota {
  plan?: string;
  windows: CodexQuotaWindow[];
  credits?: { balance?: string; unlimited: boolean };
}
export interface CodexUsageOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  signal?: AbortSignal;
}
const unavailable = () =>
  new Error('Codex usage is unavailable. Check the Codex login and connection.');

/** Read the native account view without starting a model or changing account settings. */
export async function readCodexUsage(
  authFile: string,
  options: CodexUsageOptions = {},
): Promise<CodexQuota> {
  options.signal?.throwIfAborted();
  if (path.basename(authFile) !== 'auth.json') {
    throw unavailable();
  }
  const platform = options.platform ?? process.platform;
  const environment = { ...process.env, ...options.env, CODEX_HOME: path.dirname(authFile) };
  const invocation = executableInvocation(
    resolveExecutable('codex', {
      platform,
      env: environment,
      configuredPath: options.executable,
    }),
    ['app-server', '-c', 'cli_auth_credentials_store="file"'],
    platform,
    environment,
  );
  const child = spawn(invocation.command, invocation.args, {
    env: environment,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: platform !== 'win32',
    windowsHide: true,
    ...invocation.options,
  });
  const lines = createInterface({ input: child.stdout });
  const stop = () => {
    lines.close();
    if (child.pid) {
      terminateProcessTree(child.pid, { platform, signal: 'SIGKILL' });
    }
  };
  child.on('error', stop);
  child.stdin.on('error', stop);
  let bytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      stop();
    }
  });
  options.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, 6000);
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  send({
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'cc_multi_usage', version: '0.2.1' } },
  });
  try {
    return await quotaResponse(lines, send, () => {
      if (bytes > 1024 * 1024 || options.signal?.aborted) {
        throw unavailable();
      }
    });
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
    child.stdin.destroy();
    stop();
  }
}

async function quotaResponse(
  lines: AsyncIterable<string>,
  send: (value: unknown) => unknown,
  check: () => void,
) {
  let initialized = false;
  for await (const line of lines) {
    check();
    const message: unknown = JSON.parse(line);
    if (!record(message)) {
      throw unavailable();
    }
    if (message.id === 1 && !initialized && record(message.result)) {
      initialized = true;
      send({ method: 'initialized' });
      send({ id: 2, method: 'account/rateLimits/read' });
    } else if (message.id === 2 && initialized) {
      return normalizeCodexUsage(message.result);
    } else if (message.error) {
      throw unavailable();
    }
  }
  throw unavailable();
}

/** The multi-bucket response is authoritative; never count its legacy alias twice. */
export function normalizeCodexUsage(value: unknown): CodexQuota {
  if (!record(value)) {
    throw unavailable();
  }
  const quota: CodexQuota = { windows: [] };
  for (const [id, bucket] of quotaBuckets(value).slice(0, 32)) {
    if (!record(bucket)) {
      continue;
    }
    if (typeof bucket.planType === 'string') {
      quota.plan ??= bucket.planType;
    }
    quota.credits ??= quotaCredits(bucket.credits);
    const name = typeof bucket.limitName === 'string' ? bucket.limitName : id;
    for (const slot of ['primary', 'secondary'] as const) {
      const window = quotaWindow(bucket[slot], name, slot);
      if (window) {
        quota.windows.push(window);
      }
    }
  }
  return quota;
}

function quotaCredits(value: unknown): CodexQuota['credits'] {
  if (!record(value)) {
    return undefined;
  }
  return {
    unlimited: value.unlimited === true,
    ...(typeof value.balance === 'string' ? { balance: value.balance } : {}),
  };
}

function quotaBuckets(value: Record<string, unknown>): [string, unknown][] {
  if (record(value.rateLimitsByLimitId) && Object.keys(value.rateLimitsByLimitId).length) {
    return Object.entries(value.rateLimitsByLimitId);
  }
  if (record(value.rateLimits)) {
    return [['codex', value.rateLimits]];
  }
  throw unavailable();
}

function quotaWindow(value: unknown, name: string, slot: string): CodexQuotaWindow | undefined {
  if (!record(value)) {
    return undefined;
  }
  if (
    typeof value.usedPercent !== 'number' ||
    !Number.isFinite(value.usedPercent) ||
    value.usedPercent < 0
  ) {
    throw unavailable();
  }
  const duration =
    typeof value.windowDurationMins === 'number' ? windowLabel(value.windowDurationMins) : slot;
  let resetsAt: string | undefined;
  if (typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt)) {
    const date = new Date(value.resetsAt * 1000);
    if (Number.isFinite(date.getTime())) {
      resetsAt = date.toISOString();
    }
  }
  return {
    label: `${name} · ${duration}`,
    usedPercent: value.usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
  };
}
function windowLabel(minutes: number) {
  if (minutes === 10080) {
    return 'weekly';
  }
  if (minutes >= 1440 && minutes % 1440 === 0) {
    return `${minutes / 1440} days`;
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return `${minutes / 60} hours`;
  }
  return `${minutes} minutes`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

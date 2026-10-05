import { type ChildProcess, spawn } from 'node:child_process';
import {
  executableInvocation,
  resolveExecutable,
} from '../../multi-core/src/gateway/executable.ts';
import { terminateProcessTree } from '../../multi-core/src/gateway/process-tree.ts';
import { isRecord } from '../../multi-core/src/gateway/record.ts';

interface AntigravityQuotaBucket {
  id: string;
  name: string;
  window?: string;
  remaining_fraction: number;
  reset_time?: string;
}

interface AntigravityQuotaGroup {
  name: string;
  description?: string;
  buckets: AntigravityQuotaBucket[];
}

export interface AntigravityAccountStatus {
  quota: AntigravityQuotaGroup[];
  remaining_credits?: number;
}

export function formatAntigravityQuota(status: AntigravityAccountStatus): {
  summary: string;
  details: string[];
} {
  const details = status.quota.flatMap((group) => [
    group.name,
    ...group.buckets.map((bucket) => {
      const percent = Number((bucket.remaining_fraction * 100).toFixed(2));
      const reset = bucket.reset_time ? `; resets ${bucket.reset_time}` : '';
      return `  ${bucket.name}: ${percent}% remaining${reset}`;
    }),
  ]);
  details.push(`AI credits: ${status.remaining_credits ?? 'unavailable'}`);
  return {
    summary:
      status.quota
        .flatMap((group) =>
          group.buckets.map(
            (bucket) =>
              `${group.name} · ${bucket.name}: ${Number((bucket.remaining_fraction * 100).toFixed(2))}% remaining`,
          ),
        )
        .join(' · ') || 'No native quota buckets reported',
    details,
  };
}

/** Parse the command envelope emitted by `agy -p /usage --output-format json`. */
export function parseAntigravityCommandEnvelope(value: unknown): Partial<AntigravityAccountStatus> {
  if (!isRecord(value) || !isRecord(value.command) || !isRecord(value.command.data)) {
    return {};
  }
  const data = value.command.data;
  if (value.command.name === 'credits') {
    return {
      ...(typeof data.remaining_credits === 'number' &&
      Number.isFinite(data.remaining_credits) &&
      data.remaining_credits >= 0
        ? { remaining_credits: data.remaining_credits }
        : {}),
    };
  }
  if (value.command.name !== 'usage' || !Array.isArray(data.groups)) {
    return {};
  }
  const groups = data.groups.map((group) => parseGroup(group));
  if (groups.some((group) => group === undefined)) {
    return {};
  }
  return { quota: groups as AntigravityQuotaGroup[] };
}

export async function readAntigravityAccountStatus(
  options: {
    env?: NodeJS.ProcessEnv;
    executable?: string;
    timeoutMs?: number;
    platform?: NodeJS.Platform;
    spawn?: (...args: Parameters<typeof spawn>) => ChildProcess;
  } = {},
): Promise<AntigravityAccountStatus> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const executable = resolveExecutable('agy', {
    configuredPath: options.executable,
    env,
    platform,
  });
  // Both commands must finish within the usage pane's 8.5s deadline.
  const timeoutMs = options.timeoutMs ?? 3500;
  const usage = await runCommand(executable, ['/usage'], env, platform, timeoutMs, options.spawn);
  const parsedUsage = parseAntigravityCommandEnvelope(usage);
  if (!parsedUsage.quota) {
    throw new Error('agy did not return native usage data');
  }
  const credits = await runCommand(
    executable,
    ['/credits'],
    env,
    platform,
    timeoutMs,
    options.spawn,
  ).catch(() => undefined);
  const parsedCredits = parseAntigravityCommandEnvelope(credits);
  return {
    quota: parsedUsage.quota,
    remaining_credits: parsedCredits.remaining_credits,
  };
}

function parseGroup(value: unknown): AntigravityQuotaGroup | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || !Array.isArray(value.buckets)) {
    return undefined;
  }
  const buckets = value.buckets.map((bucket) => {
    if (!isRecord(bucket) || typeof bucket.id !== 'string' || typeof bucket.name !== 'string') {
      return undefined;
    }
    if (
      typeof bucket.remaining_fraction !== 'number' ||
      !Number.isFinite(bucket.remaining_fraction) ||
      bucket.remaining_fraction < 0 ||
      bucket.remaining_fraction > 1
    ) {
      return undefined;
    }
    return {
      id: bucket.id,
      name: bucket.name,
      ...(typeof bucket.window === 'string' ? { window: bucket.window } : {}),
      remaining_fraction: bucket.remaining_fraction,
      ...(typeof bucket.reset_time === 'string' ? { reset_time: bucket.reset_time } : {}),
    };
  });
  if (buckets.some((bucket) => bucket === undefined)) {
    return undefined;
  }
  return {
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    buckets: buckets as AntigravityQuotaBucket[],
  };
}

function runCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  timeoutMs: number,
  spawnImpl: (...args: Parameters<typeof spawn>) => ChildProcess = spawn,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const invocation = executableInvocation(
      executable,
      ['-p', ...args, '--output-format', 'json'],
      platform,
      env,
    );
    const child = spawnImpl(invocation.command, invocation.args, {
      ...invocation.options,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      detached: platform !== 'win32',
    });
    let output = '';
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      if (child.pid) {
        terminateProcessTree(child.pid, { platform, signal: 'SIGKILL' });
      }
      fail(new Error('agy account status timed out'));
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (settled) {
        return;
      }
      const overflow = output.length + chunk.length > 2 * 1024 * 1024;
      output += chunk.slice(0, 2 * 1024 * 1024 - output.length);
      if (overflow) {
        if (child.pid) {
          terminateProcessTree(child.pid, { platform, signal: 'SIGKILL' });
        }
        fail(new Error('agy account status exceeded output limit'));
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      fail(new Error('Could not start native agy account command'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      if (code !== 0) {
        fail(new Error(`agy account status exited with code ${code ?? 'unknown'}`));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(output);
        settled = true;
        resolve(parsed);
      } catch {
        fail(new Error('agy returned invalid account status JSON'));
      }
    });
  });
}

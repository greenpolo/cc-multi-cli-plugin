import { isRecord } from '../../multi-core/src/gateway/record.ts';
import { queryCodex } from './app-server.ts';

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
const unavailable = () =>
  new Error('Codex usage is unavailable. Check the Codex login and connection.');

/** Read the native account view without starting a model or changing account settings. */
export async function readCodexUsage(
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<CodexQuota> {
  options.signal?.throwIfAborted();
  try {
    const [limits] = await queryCodex([{ method: 'account/rateLimits/read' }], {
      env: options.env,
      signal: options.signal,
      timeoutMs: 6000,
    });
    return normalizeCodexUsage(limits);
  } catch {
    throw unavailable();
  }
}

/** The multi-bucket response is authoritative; never count its legacy alias twice. */
function normalizeCodexUsage(value: unknown): CodexQuota {
  if (!isRecord(value)) {
    throw unavailable();
  }
  const quota: CodexQuota = { windows: [] };
  for (const [id, bucket] of quotaBuckets(value).slice(0, 32)) {
    if (!isRecord(bucket)) {
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
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    unlimited: value.unlimited === true,
    ...(typeof value.balance === 'string' ? { balance: value.balance } : {}),
  };
}

function quotaBuckets(value: Record<string, unknown>): [string, unknown][] {
  if (isRecord(value.rateLimitsByLimitId) && Object.keys(value.rateLimitsByLimitId).length) {
    return Object.entries(value.rateLimitsByLimitId);
  }
  if (isRecord(value.rateLimits)) {
    return [['codex', value.rateLimits]];
  }
  throw unavailable();
}

function quotaWindow(value: unknown, name: string, slot: string): CodexQuotaWindow | undefined {
  if (!isRecord(value)) {
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

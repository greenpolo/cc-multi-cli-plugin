import { isRecord } from '../../multi-core/src/gateway/record.ts';
import { readZenKey, validateZenKey, type ZenAuthPathOptions } from './auth.ts';

interface ZenQuotaWindow {
  status: 'ok' | 'rate-limited';
  percent: number;
  resetsAt: string;
}

interface ZenGoQuota {
  rolling: ZenQuotaWindow;
  weekly: ZenQuotaWindow;
  monthly: ZenQuotaWindow;
}

export type ZenQuotaResult =
  | { status: 'available'; quota: ZenGoQuota }
  | {
      status: 'unavailable';
      reason: 'missing-key' | 'not-go-entitled' | 'unauthorized' | 'network' | 'malformed';
    };

export interface ZenQuotaOptions extends ZenAuthPathOptions {
  apiKey?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const defaultEndpoint = 'https://opencode.ai/zen/go/v1/usage';

export async function readZenQuota(options: ZenQuotaOptions = {}): Promise<ZenQuotaResult> {
  let key: string | undefined;
  if (options.apiKey === undefined) {
    key = await readZenKey(options);
  } else if (options.apiKey) {
    key = validateZenKey(options.apiKey);
  }
  if (!key) {
    return { status: 'unavailable', reason: 'missing-key' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? 5000));
  try {
    const response = await (options.fetch ?? fetch)(options.endpoint ?? defaultEndpoint, {
      method: 'GET',
      redirect: 'error',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 401) {
      return { status: 'unavailable', reason: 'unauthorized' };
    }
    if (response.status === 403) {
      const body = await response
        .clone()
        .json()
        .catch(() => undefined);
      if (isEntitlementError(body)) {
        return { status: 'unavailable', reason: 'not-go-entitled' };
      }
      return { status: 'unavailable', reason: 'unauthorized' };
    }
    if (!response.ok) {
      return { status: 'unavailable', reason: 'network' };
    }
    const parsed: unknown = await response.json();
    const quota = parseQuota(parsed);
    return quota ? { status: 'available', quota } : { status: 'unavailable', reason: 'malformed' };
  } catch {
    return { status: 'unavailable', reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export function formatZenQuota(result: ZenQuotaResult): {
  status: 'ready' | 'unavailable' | 'error';
  summary: string;
  details: string[];
} {
  const wallet = 'Prepaid Zen balance and charges: check the Zen billing console.';
  if (result.status === 'unavailable') {
    if (result.reason === 'not-go-entitled') {
      return {
        status: 'unavailable',
        summary: 'No Go subscription for this API key',
        details: ['Go subscription quota is separate from prepaid Zen usage.', wallet],
      };
    }
    return {
      status: 'error',
      summary: 'Go subscription quota unavailable',
      details: ['Check the Zen API key and connection, then refresh.', wallet],
    };
  }
  const windows = Object.entries(result.quota).map(
    ([name, value]) =>
      `${name}: ${value.percent}% used; resets ${value.resetsAt}${value.status === 'rate-limited' ? ' · limit reached' : ''}`,
  );
  return {
    status: 'ready',
    summary: `Go · ${Object.entries(result.quota)
      .map(([name, value]) => `${name}: ${value.percent}% used`)
      .join(' · ')}`,
    details: [...windows, wallet],
  };
}

function parseQuota(value: unknown): ZenGoQuota | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) {
    return undefined;
  }
  const rolling = parseWindow(value.usage.rolling);
  const weekly = parseWindow(value.usage.weekly);
  const monthly = parseWindow(value.usage.monthly);
  return rolling && weekly && monthly ? { rolling, weekly, monthly } : undefined;
}

function parseWindow(value: unknown): ZenQuotaWindow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    (value.status !== 'ok' && value.status !== 'rate-limited') ||
    typeof value.percent !== 'number' ||
    !Number.isFinite(value.percent) ||
    value.percent < 0 ||
    typeof value.resetsAt !== 'string' ||
    !Number.isFinite(Date.parse(value.resetsAt))
  ) {
    return undefined;
  }
  return { status: value.status, percent: value.percent, resetsAt: value.resetsAt };
}

function isEntitlementError(value: unknown) {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    (value.error.type === 'EntitlementError' ||
      value.error.message === 'OpenCode Go subscription required.')
  );
}

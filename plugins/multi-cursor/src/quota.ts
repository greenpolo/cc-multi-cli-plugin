import { readFile } from 'node:fs/promises';
import { getDefaultSdkAuthPath } from '@cursor/sdk';
import { isRecord } from '../../multi-core/src/gateway/record.ts';

export interface CursorQuotaUsage {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  plan?: string;
  planUsage: Record<string, unknown>;
  spendLimitUsage?: Record<string, unknown>;
  displayMessage?: string;
  enabled?: boolean;
}

export interface CursorQuotaView {
  summary: string;
  details: string[];
}

export interface CursorQuotaOptions {
  authFile?: string;
  backendUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

interface CursorCredentials {
  apiKey?: unknown;
  backendUrl?: unknown;
  apiKeyExpiresAtMs?: unknown;
}

const defaultBackendUrl = 'https://api2.cursor.sh';

export async function readCursorQuota(options: CursorQuotaOptions = {}): Promise<CursorQuotaUsage> {
  const env = options.env ?? process.env;
  const credentials = await loadCredentials(options.authFile ?? getDefaultSdkAuthPath(), env);
  const backendUrl = resolveBackend(credentials, options, env);
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(8000),
  ]);
  try {
    return await fetchQuota(
      credentials.apiKey as string,
      backendUrl,
      options.fetchImpl ?? fetch,
      signal,
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'Cursor quota is unavailable') {
      throw error;
    }
    throw unavailable();
  }
}

async function loadCredentials(
  authFile: string,
  env: NodeJS.ProcessEnv,
): Promise<CursorCredentials> {
  const envKey = env.CURSOR_API_KEY;
  if (envKey) {
    return { apiKey: envKey, backendUrl: env.CURSOR_BACKEND_URL };
  }
  try {
    return parseCredentials(await readFile(authFile, 'utf8'));
  } catch {
    throw unavailable();
  }
}

function resolveBackend(
  credentials: CursorCredentials,
  options: CursorQuotaOptions,
  env: NodeJS.ProcessEnv,
): string {
  const selected = options.backendUrl ?? env.CURSOR_BACKEND_URL ?? defaultBackendUrl;
  if (
    typeof selected !== 'string' ||
    !selected ||
    typeof credentials.apiKey !== 'string' ||
    !credentials.apiKey
  ) {
    throw unavailable();
  }
  if (!env.CURSOR_API_KEY && credentials.backendUrl !== selected) {
    throw unavailable();
  }
  if (
    typeof credentials.apiKeyExpiresAtMs === 'number' &&
    credentials.apiKeyExpiresAtMs <= Date.now()
  ) {
    throw unavailable();
  }
  return selected;
}

async function fetchQuota(
  apiKey: string,
  backendUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<CursorQuotaUsage> {
  const exchange = await fetchImpl(`${backendUrl}/auth/exchange_user_api_key`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal,
  });
  if (!exchange.ok) {
    throw unavailable();
  }
  const token = parseObject(await exchange.json());
  if (typeof token.accessToken !== 'string' || !token.accessToken) {
    throw unavailable();
  }
  const response = await fetchImpl(
    `${backendUrl}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        'content-type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: '{}',
      redirect: 'error',
      signal,
    },
  );
  if (!response.ok) {
    throw unavailable();
  }
  const value = parseObject(await response.json());
  if (!isRecord(value.planUsage) || value.enabled === false) {
    throw unavailable();
  }
  return {
    ...(typeof value.billingCycleStart === 'string'
      ? { billingCycleStart: value.billingCycleStart }
      : {}),
    ...(typeof value.billingCycleEnd === 'string'
      ? { billingCycleEnd: value.billingCycleEnd }
      : {}),
    ...(typeof value.plan === 'string' ? { plan: value.plan } : {}),
    planUsage: value.planUsage,
    ...(isRecord(value.spendLimitUsage) ? { spendLimitUsage: value.spendLimitUsage } : {}),
    ...(typeof value.displayMessage === 'string' ? { displayMessage: value.displayMessage } : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
  };
}

export function formatCursorQuota(quota: CursorQuotaUsage): CursorQuotaView {
  const details: string[] = [];
  const usage: string[] = [];
  const percentages = [
    ['total', quota.planUsage.totalPercentUsed],
    ['Auto', quota.planUsage.autoPercentUsed],
    ['API', quota.planUsage.apiPercentUsed],
  ] as const;
  for (const [label, value] of percentages) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      usage.push(`${label}: ${value.toFixed(2)}% used`);
    }
  }
  if (!usage.length) {
    throw unavailable();
  }
  if (quota.billingCycleStart || quota.billingCycleEnd) {
    details.push(
      `Billing cycle: ${formatDate(quota.billingCycleStart)} to ${formatDate(quota.billingCycleEnd)}`,
    );
  }
  if (quota.displayMessage) {
    details.push(quota.displayMessage);
  }
  return {
    summary: `${quota.plan ? `${quota.plan} · ` : ''}${usage.join(' · ')}`,
    details: [...usage, ...details],
  };
}

function parseCredentials(text: string): CursorCredentials {
  return parseObject(JSON.parse(text));
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw unavailable();
  }
  return value;
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return '?';
  }
  const milliseconds = Number(value);
  if (Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 8.64e15) {
    return new Date(milliseconds).toISOString();
  }
  return value;
}

function unavailable(): Error {
  return new Error('Cursor quota is unavailable');
}

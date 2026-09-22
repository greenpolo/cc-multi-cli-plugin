import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Grok Build exposes no account quota endpoint, so the useful account fact is the
 * login itself: it eventually lapses and a run then fails for a reason that looks
 * nothing like an expiry. `expires_at` is only the access token's own clock — a
 * measured six hours — which the CLI renews silently from its refresh token, so a
 * renewable credential is reported as signed in however old that clock is.
 */
export interface GrokAuthStatus {
  signedIn: boolean;
  renewable?: boolean;
  expiresAt?: number;
}

export interface GrokAuthOptions {
  platform?: NodeJS.Platform;
  homedir?: string;
}

export function grokAuthFile(options: GrokAuthOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(options.homedir ?? os.homedir(), '.grok', 'auth.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Loads native auth to report key/refresh-token presence and access-token expiry only. */
export async function readGrokAuth(options: GrokAuthOptions = {}): Promise<GrokAuthStatus> {
  let source: string;
  try {
    source = await readFile(grokAuthFile(options), 'utf8');
  } catch {
    return { signedIn: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { signedIn: false };
  }
  if (!isRecord(parsed)) {
    return { signedIn: false };
  }
  for (const entry of Object.values(parsed)) {
    if (!isRecord(entry) || typeof entry.key !== 'string' || !entry.key) {
      continue;
    }
    const expires =
      typeof entry.expires_at === 'string' ? Date.parse(entry.expires_at) : Number.NaN;
    return {
      signedIn: true,
      renewable: typeof entry.refresh_token === 'string' && entry.refresh_token.length > 0,
      ...(Number.isFinite(expires) ? { expiresAt: expires } : {}),
    };
  }
  return { signedIn: false };
}

export function formatGrokQuota(
  status: GrokAuthStatus,
  now = Date.now(),
): { summary: string; details: string[]; status?: 'ready' | 'unavailable' | 'error' } {
  if (!status.signedIn) {
    return {
      summary: 'No Grok account login',
      details: ['Run grok login in your own terminal, then relaunch.'],
      status: 'unavailable',
    };
  }
  const details = [
    'Grok Build bills each run to the subscription; per-run cost appears in session receipts.',
    'The CLI exposes no account quota; check your SuperGrok or X Premium Plus plan for limits.',
  ];
  if (status.renewable) {
    // The CLI refreshes its own access token, so its clock says nothing about when
    // a new sign-in will be needed. Claiming an expiry here would be a false alarm.
    return {
      summary: 'Signed in',
      details: [
        'The CLI renews its own access token and asks for a new sign-in periodically.',
        ...details,
      ],
    };
  }
  if (status.expiresAt === undefined) {
    return { summary: 'Signed in', details };
  }
  const hours = Math.floor((status.expiresAt - now) / 3_600_000);
  if (hours <= 0) {
    return {
      summary: 'Login expired',
      details: ['The browser credential has expired. Run grok login, then relaunch.', ...details],
      status: 'unavailable',
    };
  }
  const remaining = hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
  return { summary: `Signed in · access valid ${remaining}`, details };
}

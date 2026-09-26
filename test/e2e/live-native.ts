import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable } from '../../plugins/multi-core/src/gateway/executable.ts';
import type { JsonObject } from './types.ts';

interface NativeCredential {
  available: boolean;
  reason: string;
  env?: Record<string, string>;
  fixtures?: Record<string, string>;
}

async function objectFile(filename: string): Promise<JsonObject> {
  try {
    const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
    return record(value) ?? {};
  } catch {
    return {};
  }
}

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

async function cursorCredential(): Promise<NativeCredential> {
  const { getDefaultSdkAuthPath } = await import('@cursor/sdk');
  const auth = await objectFile(getDefaultSdkAuthPath());
  const key = process.env.CURSOR_API_KEY ?? auth.apiKey;
  if (typeof key !== 'string' || !key.trim()) {
    return { available: false, reason: 'Cursor SDK login absent' };
  }
  // The launcher uses this key; HOME, SDK run state, and workspaces stay isolated.
  return {
    available: true,
    reason: 'Cursor SDK login present (isolated API-key injection)',
    env: { CURSOR_API_KEY: key },
  };
}

async function grokCredential(): Promise<NativeCredential> {
  const auth = await objectFile(path.join(os.homedir(), '.grok', 'auth.json'));
  const access: JsonObject = {};
  for (const [name, value] of Object.entries(auth)) {
    const entry = record(value);
    if (!entry || typeof entry.key !== 'string' || !entry.key) {
      continue;
    }
    // Never rotate a copied refresh token: renewal invalidates the user's original.
    const expires = typeof entry.expires_at === 'string' ? Date.parse(entry.expires_at) : NaN;
    if (!Number.isFinite(expires) || expires <= Date.now() + 60_000) {
      continue;
    }
    access[name] = { key: entry.key, expires_at: entry.expires_at };
  }
  if (!Object.keys(access).length) {
    return {
      available: false,
      reason:
        'Grok unexpired access login absent; renew outside E2E (refresh tokens are never copied)',
    };
  }
  return {
    available: true,
    reason: 'Grok access login present (isolated snapshot, no refresh token)',
    fixtures: { '.grok/auth.json': JSON.stringify(access) },
  };
}

/** Offline only: no native login commands, keyring prompts, token refresh, or inference. */
export async function detectNativeLiveProvider(
  provider: 'cursor' | 'antigravity' | 'grok',
): Promise<NativeCredential> {
  if (provider === 'cursor') {
    return cursorCredential();
  }
  try {
    resolveExecutable(provider === 'antigravity' ? 'agy' : 'grok');
  } catch {
    return {
      available: false,
      reason: `${provider === 'antigravity' ? 'agy' : 'grok'} executable absent`,
    };
  }
  if (provider === 'grok') {
    return grokCredential();
  }
  // agy has no documented offline auth-status/export command. Its OS credential
  // service is not isolated by HOME; probing /usage can refresh that shared login.
  // Never infer login from a binary/catalog or share a writable native keyring.
  return {
    available: false,
    reason:
      'agy executable present; offline login presence and isolated OS credential export unavailable (no account or inference calls made)',
  };
}

/** Unshadow the hermetic native shims, but retain the scenario's isolated HOME. */
export function nativeLiveEnvironment(providers: readonly string[]): Record<string, string> {
  if (!providers.some((provider) => ['cursor', 'antigravity', 'grok'].includes(provider))) {
    return {};
  }
  return {
    PATH: process.env.PATH ?? '',
    MULTI_ANTIGRAVITY: providers.includes('antigravity') ? '1' : '0',
    MULTI_GROK: providers.includes('grok') ? '1' : '0',
  };
}

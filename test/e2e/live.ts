import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { readGrokAuth } from '../../plugins/multi-grok/src/usage.ts';
import { readZenKey } from '../../plugins/multi-zen/src/auth.ts';
import type { JsonObject, Scenario } from './types.ts';

export type LiveProvider = 'anthropic' | 'openai' | 'zen' | 'cursor' | 'antigravity' | 'grok';
export interface LivePlan {
  providers: LiveProvider[];
  purpose: 'compaction' | 'subagent' | 'main-session' | 'plan' | 'permissions';
  prompt: string;
  maxTurns: number;
  maxBudgetUsd: number;
  model?: string;
}
interface Credential {
  available: boolean;
  reason: string;
  env?: Record<string, string>;
  fixtures?: Record<string, string>;
}
async function objectFile(filename: string): Promise<JsonObject> {
  try {
    return JSON.parse(await readFile(filename, 'utf8')) as JsonObject;
  } catch {
    return {};
  }
}
function record(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}
function keyCredential(name: string, value: unknown): Credential {
  const available = typeof value === 'string' && value.length > 0;
  return {
    available,
    reason: available ? 'credential present' : 'credential absent',
    ...(available ? { env: { [name]: value } } : {}),
  };
}

/** Presence-only checks; never prints credentials, refreshes tokens, or probes inference. */
export async function detectLiveProvider(provider: LiveProvider): Promise<Credential> {
  const home = os.homedir();
  if (provider === 'anthropic') {
    return anthropicCredential(home);
  }
  if (provider === 'openai') {
    return openaiCredential(home);
  }
  if (provider === 'zen') {
    return keyCredential('OPENCODE_API_KEY', await readZenKey());
  }
  if (provider === 'grok') {
    const status = await readGrokAuth();
    return {
      available: status.signedIn,
      reason: status.signedIn ? 'Grok login present' : 'Grok login absent',
    };
  }
  if (provider === 'cursor') {
    if (process.env.CURSOR_API_KEY) {
      return keyCredential('CURSOR_API_KEY', process.env.CURSOR_API_KEY);
    }
    const { getDefaultSdkAuthPath } = await import('@cursor/sdk');
    const auth = await objectFile(getDefaultSdkAuthPath());
    return keyCredential('CURSOR_API_KEY', auth.apiKey);
  }
  return { available: false, reason: 'Antigravity credential-presence probe not yet implemented' };
}

export async function prepareLive(t: TestContext, scenario: Scenario) {
  const plan = scenario.live;
  if (!plan) {
    t.skip('Live variant not yet scripted for this scenario');
    return undefined;
  }
  if (
    !(plan.maxTurns > 0 && plan.maxTurns <= 6 && plan.maxBudgetUsd > 0 && plan.maxBudgetUsd <= 1)
  ) {
    throw new Error('Live scenarios require 1–6 turns and a positive budget of at most $1');
  }
  const credentials = await Promise.all(
    plan.providers.map(async (provider) => ({
      provider,
      credential: await detectLiveProvider(provider),
    })),
  );
  const missing = credentials.filter(({ credential }) => !credential.available);
  if (missing.length) {
    t.skip(
      missing.map(({ provider, credential }) => `${provider}: ${credential.reason}`).join('; '),
    );
    return undefined;
  }
  if (plan.providers.some((provider) => ['cursor', 'antigravity', 'grok'].includes(provider))) {
    t.skip('Native live execution awaits an isolated provider-login adapter; no calls made');
    return undefined;
  }
  return {
    env: Object.assign({}, ...credentials.map(({ credential }) => credential.env)) as Record<
      string,
      string
    >,
    fixtures: Object.assign(
      {},
      ...credentials.map(({ credential }) => credential.fixtures),
    ) as Record<string, string>,
    scenario: {
      ...scenario,
      prompt: plan.prompt,
      model: plan.model ?? scenario.model,
      cliArgs: [
        ...(scenario.cliArgs ?? []),
        '--max-turns',
        String(plan.maxTurns),
        '--max-budget-usd',
        String(plan.maxBudgetUsd),
      ],
    },
  };
}

async function anthropicCredential(home: string): Promise<Credential> {
  const explicit = process.env.MULTI_E2E_LIVE_ANTHROPIC_API_KEY;
  if (explicit) {
    return keyCredential('ANTHROPIC_API_KEY', explicit);
  }
  const auth = await objectFile(
    path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), '.credentials.json'),
  );
  const oauth = record(auth.claudeAiOauth);
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) {
    return { available: false, reason: 'Claude OAuth expired; renew outside E2E' };
  }
  return keyCredential('ANTHROPIC_AUTH_TOKEN', oauth.accessToken);
}

async function openaiCredential(home: string): Promise<Credential> {
  const auth = await objectFile(
    path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'auth.json'),
  );
  const tokens = record(auth.tokens);
  const available =
    auth.auth_mode === 'chatgpt' &&
    typeof tokens.access_token === 'string' &&
    typeof tokens.account_id === 'string';
  return {
    available,
    reason: available ? 'Codex login present' : 'Codex login absent',
    // Copy only access material; never rotate the user's native refresh token.
    fixtures: {
      'codex/auth.json': JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: tokens.access_token, account_id: tokens.account_id },
      }),
    },
  };
}

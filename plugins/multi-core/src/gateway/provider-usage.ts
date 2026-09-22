import type { UsageSnapshot } from './receipts.ts';

type UsageProvider = 'openai' | 'cursor' | 'zen' | 'antigravity' | 'grok';
interface ProviderUsageRow {
  id: UsageProvider;
  name: string;
  status: 'ready' | 'unavailable' | 'disabled' | 'error';
  summary: string;
  details: string[];
  url?: string;
}
export interface ProviderUsageView {
  updatedAt: string;
  providers: ProviderUsageRow[];
}
export interface ProviderUsageOptions {
  enabled: readonly string[];
  openai?: ProviderUsageReader;
  cursor?: ProviderUsageReader;
  zen?: ProviderUsageReader;
  antigravity?: ProviderUsageReader;
  grok?: ProviderUsageReader;
  now?: () => number;
}
export type ProviderUsageReader = (session: string) => Promise<{
  summary: string;
  details: string[];
  status?: ProviderUsageRow['status'];
}>;
const providers = [
  { id: 'openai', name: 'OpenAI / Codex', url: 'https://chatgpt.com/codex/settings/usage' },
  { id: 'cursor', name: 'Cursor', url: 'https://cursor.com/dashboard?tab=usage' },
  { id: 'zen', name: 'OpenCode Zen', url: 'https://opencode.ai/zen' },
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'grok', name: 'Grok Build', url: 'https://x.ai/build' },
] as const;
const unavailable: Record<UsageProvider, string[]> = {
  openai: ['Sign in with codex login to read account quota windows.'],
  cursor: ['Sign in with the Cursor SDK to read subscription quota.'],
  zen: [
    'Go subscription quota requires a supported Zen API key.',
    'Check the Zen billing console for credits and charges.',
  ],
  antigravity: [
    'Native Antigravity account quota could not be retrieved.',
    'Run /usage or /credits inside agy to view your account.',
  ],
  grok: [
    'Grok Build exposes no account quota; per-run cost appears in session receipts.',
    'Run grok login if the browser credential has expired.',
  ],
};

function sessionLines(snapshot: UsageSnapshot, provider: UsageProvider): string[] {
  const entries = snapshot.entries.filter((entry) => entry.provider === provider);
  const totals = { input: 0, output: 0, read: 0, write: 0, requests: 0 };
  for (const entry of entries) {
    totals.input += entry.usage.input_tokens;
    totals.output += entry.usage.output_tokens;
    totals.read += entry.usage.cache_read_input_tokens;
    totals.write += entry.usage.cache_creation_input_tokens;
    totals.requests += entry.requests;
  }
  const count = (value: number) => value.toLocaleString('en-US');
  return [
    `This session: ${count(totals.requests)} completed requests`,
    `Tokens: ${count(totals.input)} input · ${count(totals.output)} output`,
    `Cache: ${count(totals.read)} read · ${count(totals.write)} written`,
    ...(entries.some((entry) => entry.source !== 'provider')
      ? ['Includes estimated or unavailable counts; see session receipts for provenance.']
      : []),
  ];
}

/** Read-only account lookups are cached and coalesced independently of model requests. */
export class ProviderUsageDashboard {
  private readonly cache = new Map<string, { expires: number; view: ProviderUsageView }>();
  private readonly pending = new Map<string, Promise<ProviderUsageView>>();
  private readonly now: () => number;
  private readonly options: ProviderUsageOptions;
  constructor(options: ProviderUsageOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async read(
    session: string,
    snapshot: UsageSnapshot,
    refresh = false,
  ): Promise<ProviderUsageView> {
    const active = this.pending.get(session);
    if (active) {
      return this.withSession(await active, snapshot);
    }
    const saved = this.cache.get(session);
    if (!refresh && saved && saved.expires > this.now()) {
      return this.withSession(saved.view, snapshot);
    }
    if (this.pending.size >= 32) {
      throw new Error('Too many simultaneous usage queries');
    }
    const request = this.collect(session);
    this.pending.set(session, request);
    try {
      const view = await request;
      if (this.cache.size >= 32) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) {
          this.cache.delete(oldest);
        }
      }
      this.cache.set(session, { expires: this.now() + 30000, view });
      return this.withSession(view, snapshot);
    } finally {
      this.pending.delete(session);
    }
  }

  private async collect(session: string): Promise<ProviderUsageView> {
    const rows = await Promise.all(
      providers.map(async (provider): Promise<ProviderUsageRow> => {
        const row: ProviderUsageRow = {
          ...provider,
          status: 'unavailable',
          summary: 'Account usage unavailable',
          details: unavailable[provider.id],
        };
        if (!this.options.enabled.includes(provider.id)) {
          return {
            ...row,
            status: 'disabled',
            summary: 'Not enabled in this launcher',
            details: [],
          };
        }
        const reader = this.options[provider.id];
        if (!reader) {
          return row;
        }
        try {
          const data = await reader(session);
          return { ...row, status: 'ready', ...data };
        } catch {
          return {
            ...row,
            status: 'error',
            summary: 'Could not refresh provider usage',
            details: ['Check the provider login or connection, then refresh.', ...row.details],
          };
        }
      }),
    );
    return { updatedAt: new Date(this.now()).toISOString(), providers: rows };
  }

  private withSession(view: ProviderUsageView, snapshot: UsageSnapshot): ProviderUsageView {
    return {
      ...view,
      providers: view.providers.map((row) => ({
        ...row,
        details: [...row.details, ...sessionLines(snapshot, row.id)],
      })),
    };
  }
}

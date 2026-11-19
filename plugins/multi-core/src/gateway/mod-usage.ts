import type { IncomingMessage } from 'node:http';
import type { ProviderUsageDashboard } from './provider-usage.ts';
import type { ReceiptLedger, ReceiptOutcome } from './receipts.ts';

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 512) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function outcome(value: unknown): ReceiptOutcome {
  switch (value) {
    case 'answer':
      return 'completed';
    case 'aborted':
      return 'cancelled';
    case 'error':
    case 'refusal':
      return 'failed';
    default:
      throw new Error('Invalid usage outcome');
  }
}

export async function usageRoute(
  req: IncomingMessage,
  url: URL,
  parsed: unknown,
  ledger: ReceiptLedger,
  billed?: { scope: string; read(session: string): Promise<unknown> },
  dashboard?: ProviderUsageDashboard,
) {
  if (url.pathname === '/multi/mod/usage/complete') {
    if (req.method !== 'POST' || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Usage completion requires POST with an object');
    }
    const body = parsed as Record<string, unknown>;
    const receipt = ledger.complete(
      {
        session: identifier(body.sessionId, 'sessionId'),
        agentId: body.agentId === undefined ? undefined : identifier(body.agentId, 'agentId'),
        invocationId: identifier(body.turnId, 'turnId'),
      },
      outcome(body.outcome),
    );
    return { accepted: true, receipt };
  }
  if (req.method !== 'GET') {
    throw new Error('Usage query requires GET');
  }
  const session = identifier(url.searchParams.get('sessionId'), 'sessionId');
  if (url.pathname === '/multi/mod/receipts') {
    return { receipts: ledger.recent(session) };
  }
  if (url.searchParams.get('view') === 'providers') {
    if (!dashboard) {
      throw new Error('Provider usage is unavailable');
    }
    return dashboard.read(
      session,
      ledger.snapshot(session),
      url.searchParams.get('refresh') === 'true',
    );
  }
  if (url.searchParams.get('billed') === 'true') {
    if (!billed) {
      return {
        status: 'unavailable',
        message: 'Billed usage is unavailable in this session.',
      };
    }
    return {
      scope: billed.scope,
      currency: 'USD',
      costUnit: 'cents',
      agents: await billed.read(session),
    };
  }
  return ledger.snapshot(session);
}

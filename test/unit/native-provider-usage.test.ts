import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderUsageDashboard,
  type ProviderUsageView,
} from '../../plugins/multi-core/src/gateway/provider-usage.ts';
import { ReceiptLedger } from '../../plugins/multi-core/src/gateway/receipts.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';

const empty = () => new ReceiptLedger().snapshot();
test('provider dashboard reads every enabled provider and preserves unavailable quota status', async () => {
  const calls: string[] = [];
  const reader = (provider: string) => async (session: string) => {
    calls.push(`${provider}:${session}`);
    return { summary: `${provider} quota`, details: ['Account snapshot'] };
  };
  const dashboard = new ProviderUsageDashboard({
    enabled: ['openai', 'cursor', 'zen', 'antigravity'],
    openai: reader('openai'),
    cursor: reader('cursor'),
    zen: reader('zen'),
    antigravity: async () => ({
      summary: 'Native quota unavailable',
      details: ['No native quota connection'],
      status: 'unavailable',
    }),
  });
  const result = await dashboard.read('owned', empty());
  assert.deepEqual(calls.sort(), ['cursor:owned', 'openai:owned', 'zen:owned']);
  assert.deepEqual(
    result.providers.map((row) => row.status),
    ['ready', 'ready', 'ready', 'unavailable', 'disabled'],
  );
  assert.equal(result.providers[2].summary, 'zen quota');
  assert(result.providers[3].details.includes('No native quota connection'));
});

test('provider dashboard isolates errors and explicitly reports disabled and unsupported billing', async () => {
  const dashboard = new ProviderUsageDashboard({
    enabled: ['openai', 'cursor', 'zen'],
    openai: async () => ({ summary: 'quota', details: ['50% used'] }),
    cursor: async () => {
      throw new Error('secret token');
    },
  });
  const result = await dashboard.read('s', empty());
  assert.deepEqual(
    result.providers.map((row) => row.status),
    ['ready', 'error', 'unavailable', 'disabled', 'disabled'],
  );
  assert(!JSON.stringify(result).includes('secret'));
  assert(result.providers[2].details.some((line) => line.includes('billing console')));
});

test('provider dashboard coalesces reads, caches account data, refreshes and keeps session counts fresh', async () => {
  let calls = 0;
  let now = 0;
  const dashboard = new ProviderUsageDashboard({
    enabled: ['cursor'],
    now: () => now,
    cursor: async (session) => {
      calls++;
      return { summary: session, details: [] };
    },
  });
  const ledger = new ReceiptLedger();
  await Promise.all([
    dashboard.read('a', ledger.snapshot()),
    dashboard.read('a', ledger.snapshot(), true),
  ]);
  assert.equal(calls, 1);
  ledger.observe({ route: 'cursor', session: 'a', usage: { input_tokens: 10, output_tokens: 20 } });
  const cached = await dashboard.read('a', ledger.snapshot('a'));
  assert.equal(calls, 1);
  assert(
    cached.providers[1].details.includes('Tokens: context 10 · consumed 10 input · cached 0 read'),
  );
  assert(cached.providers[1].details.includes('Output: 20 · cache written 0'));
  cached.providers[1].details.push('mutation');
  assert(!(await dashboard.read('a', empty())).providers[1].details.includes('mutation'));
  await dashboard.read('b', empty());
  assert.equal(calls, 2);
  await dashboard.read('a', empty(), true);
  assert.equal(calls, 3);
  now = 30001;
  await dashboard.read('a', empty());
  assert.equal(calls, 4);
});

test('provider menu route is authenticated, session scoped and read-only', async (t) => {
  let reads = 0;
  const dashboard = new ProviderUsageDashboard({
    enabled: ['cursor'],
    cursor: async (session) => {
      reads++;
      return { summary: session, details: [] };
    },
  });
  const server = createNativeGateway({
    token: 'secret',
    authFile: 'unused',
    usageDashboard: dashboard,
    fetchImpl: async () => {
      throw new Error('Menu must not infer');
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/multi/mod/usage?sessionId=owned&view=providers`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(reads, 0);
  const response = await fetch(url, { headers: { 'x-multi-gateway-token': 'secret' } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as ProviderUsageView;
  assert.equal(body.providers[1].summary, 'owned');
  assert.equal(reads, 1);
});

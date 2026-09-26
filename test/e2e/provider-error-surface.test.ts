import assert from 'node:assert/strict';
import test from 'node:test';
import { rawUpstream, sse } from './fixtures/provider-wire/raw-upstream.ts';
import { runScenario } from './harness.ts';

for (const provider of ['openai', 'zen'] as const) {
  for (const status of [401, 429, 500]) {
    test(`provider-error-surface: ${provider} HTTP ${status}`, async (t) => {
      const result = await runScenario(t, {
        name: 'provider-error-surface',
        enabledProviders: [provider],
        model: `multi/${provider}/${provider === 'openai' ? 'gpt-6-astra' : 'kimi-k3'}`,
        upstream: {
          [provider]: () => ({
            status,
            json: { error: { message: `E2E upstream ${status}`, type: 'api_error' } },
          }),
        },
      });
      if (!result) {
        return;
      }
      assert.ok(result.requests.some((request) => request.provider === provider));
      assert.ok(
        result.transcript.some((event) => event.type === 'result' && event.is_error),
        result.stdout,
      );
      assert.ok(!result.transcript.some((event) => event.type === 'result' && !event.is_error));
      assert.match(result.stdout, new RegExp(String(status)));
      for (const secret of ['e2e-dummy-openai', 'e2e-dummy-zen', 'e2e-dummy-anthropic']) {
        assert.ok(!(result.stdout + result.stderr).includes(secret));
      }
      assert.deepEqual(result.upstreamErrors, []);
    });
  }
}

for (const [name, stream] of [
  [
    'truncated',
    sse('response.created', { response: { id: 'resp_broken', status: 'in_progress', output: [] } }),
  ],
  ['malformed', 'event: response.completed\ndata: {not-json}\n\n'],
]) {
  test(`provider-error-surface: OpenAI ${name} SSE`, async (t) => {
    const raw = await rawUpstream(t, stream ?? '');
    const result = await runScenario(t, {
      name: `provider-error-${name}`,
      enabledProviders: ['openai'],
      model: 'multi/openai/gpt-6-astra',
      env: raw.env,
    });
    if (!result) {
      return;
    }
    assert.ok(raw.requests.length > 0);
    assert.ok(
      result.transcript.some((event) => event.type === 'result' && event.is_error),
      result.stdout,
    );
    assert.ok(!result.transcript.some((event) => event.type === 'result' && !event.is_error));
    assert.ok(!(result.stdout + result.stderr).includes('e2e-dummy-openai'));
  });
}

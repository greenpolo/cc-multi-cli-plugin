import assert from 'node:assert/strict';
import test from 'node:test';
import { runScenario } from './harness.ts';

for (const [provider, model] of [
  ['openai', 'gpt-6-astra'],
  ['zen', 'kimi-k2.7-code'],
  ['zen', 'gpt-6-luna'],
] as const) {
  for (const gatewayTimeoutMs of [undefined, 50]) {
    test(`${provider}/${model} long stream: ${gatewayTimeoutMs ? 'explicit timeout aborts' : 'no implicit deadline'}`, async (t) => {
      const result = await runScenario(t, {
        name: 'direct-provider-long-stream',
        model: `multi/${provider}/${model}`,
        enabledProviders: [provider],
        gatewayTimeoutMs,
        upstream: {
          [provider]: () => ({ text: 'Slow provider stream completed.', delayMs: 400 }),
        },
      });
      if (!result) {
        return;
      }
      const requests = result.requests.filter(
        (request) => request.provider === provider && request.body.model === model,
      );
      // Claude may retry a failed streaming response once without streaming. Under load a
      // 50 ms deadline can also expire before the request reaches the fake provider.
      assert.ok(requests.length <= 2, result.stderr + result.stdout);
      assert.equal(result.hookAcks.length, 1);
      assert.deepEqual(result.upstreamErrors, []);
      if (gatewayTimeoutMs) {
        assert.ok(
          requests.every((request) => request.aborted),
          result.stderr + result.stdout,
        );
        assert.ok(!result.transcript.some((event) => event.type === 'result' && !event.is_error));
        assert.doesNotMatch(result.stdout, /Slow provider stream completed/);
      } else {
        assert.equal(requests.length, 1);
        assert.equal(result.code, 0, result.stderr + result.stdout);
        assert.match(result.stdout, /Slow provider stream completed/);
        assert.ok(result.transcript.some((event) => event.type === 'result' && !event.is_error));
        assert.equal(requests[0]?.aborted, false);
        assert.ok(result.elapsedMs >= 400);
      }
    });
  }
}

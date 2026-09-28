import assert from 'node:assert/strict';
import test from 'node:test';
import { runScenario } from './harness.ts';

for (const gatewayTimeoutMs of [undefined, 50]) {
  test(`claude-long-stream: ${gatewayTimeoutMs ? 'explicit timeout aborts' : 'no implicit deadline'}`, async (t) => {
    const result = await runScenario(t, {
      name: 'claude-long-stream',
      gatewayTimeoutMs,
      env: {
        ANTHROPIC_AUTH_TOKEN: 'e2e-oauth',
        ANTHROPIC_CUSTOM_HEADERS: 'anthropic-beta: e2e-beta',
      },
      // A loaded gateway can fire a 50 ms timer hundreds of milliseconds late; the
      // timed-out reply stays pending long enough that only the deadline can end it.
      upstream: {
        anthropic: () => ({
          text: 'Slow stream completed.',
          delayMs: gatewayTimeoutMs ? 5000 : 400,
        }),
      },
    });
    if (!result) {
      return;
    }
    const message = result.requests.find(({ path }) => path.startsWith('/v1/messages?'));
    assert.ok(message, result.stderr);
    assert.equal(message.headers['x-multi-gateway-token'], undefined);
    assert.equal(message.headers.authorization, 'Bearer e2e-oauth');
    assert.match(String(message.headers['anthropic-beta']), /claude-code-/);
    assert.ok(!JSON.stringify(message).includes('e2e-dummy-openai'));
    assert.equal(message.raw, result.gatewayRequests[0]?.raw);
    assert.equal(
      message.headers['anthropic-beta'],
      result.gatewayRequests[0]?.headers['anthropic-beta'],
    );
    assert.equal(result.hookAcks.length, 1);
    if (gatewayTimeoutMs) {
      assert.ok(message.aborted, result.stderr + result.stdout);
      assert.ok(!result.transcript.some((event) => event.type === 'result' && !event.is_error));
    } else {
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /Slow stream completed/);
      assert.ok(result.elapsedMs >= 400);
    }
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { runScenario } from './harness.ts';

// A local-only TLS diagnostic on 2.1.283 identified the three CONNECTs as GETs:
// /api/claude_cli/bootstrap?entrypoint=sdk-cli&model=...
// /api/claude_code_penguin_mode
// /mcp-registry/v0/servers?version=latest&limit=100&visibility=...
// Narrow telemetry/updater flags (including DISABLE_GROWTHBOOK) do not stop them.
// The broad NONESSENTIAL flag does, but also blocks function-hook loopback fetches.
// Keep the rejecting proxy: none of these requests is needed for scripted inference.
test('network policy: ancillary traffic is rejected without provider inference', async (t) => {
  const result = await runScenario(t, {
    name: 'network-policy',
    upstream: { anthropic: () => ({ text: 'ok' }) },
  });
  if (!result) {
    return;
  }
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.hookAcks.length, 1);
  assert.ok(result.blockedConnections.every((target) => target === 'api.anthropic.com:443'));
  t.diagnostic(`Blocked ancillary CONNECTs: ${result.blockedConnections.length}`);
});

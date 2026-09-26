import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { registeredWorker } from './agents.ts';
import { runScenario } from './harness.ts';

for (const provider of ['openai', 'zen'] as const) {
  const model = provider === 'openai' ? 'gpt-6-astra' : 'kimi-k3';
  test(`${provider}-worker: Agent dispatch and saved credential isolation`, async (t) => {
    const key = 'e2e-saved-zen-secret';
    const result = await runScenario(t, {
      name: `${provider}-worker`,
      enabledProviders: [provider],
      permissionMode: 'bypassPermissions',
      // The common harness injects a dummy environment key. Remove it before
      // launcher startup so this scenario can prove the saved-auth path instead.
      env: {
        NODE_OPTIONS:
          process.env.MULTI_E2E_LIVE === '1'
            ? ''
            : '--import=data:text/javascript,delete%20process.env.OPENCODE_API_KEY',
        MULTI_ZEN_MODELS: 'kimi-k3',
      },
      fixtures: {
        '.local/share/opencode/auth.json': JSON.stringify({ opencode: { type: 'api', key } }),
        'opencode/auth.json': JSON.stringify({ opencode: { type: 'api', key } }),
      },
      live: {
        providers: ['anthropic', provider],
        purpose: 'subagent',
        prompt: `Use the advertised agent list to spawn exactly one ${provider} worker running ${model}. For a per-provider worker, pass model multi/${provider}/${model}; for a per-model worker, select its matching registration. Ask it to reply WORKER_OK without tools. Then reply WORKER_OK. Do nothing else.`,
        maxTurns: 3,
        maxBudgetUsd: 0.2,
      },
      upstream: {
        [provider]: () => ({ text: 'WORKER_OK' }),
        anthropic: (request, index) => {
          if (index === 0) {
            return {
              tool: {
                name: 'Bash',
                input: {
                  command: `node -e "require('fs').writeFileSync('child-env.json', JSON.stringify(process.env))"`,
                  description: 'Record isolated child environment',
                },
              },
            };
          }
          if (index === 1) {
            return {
              tool: {
                name: 'Agent',
                id: 'toolu_worker',
                input: {
                  ...registeredWorker(request, provider, model),
                  description: 'Bounded provider worker',
                  prompt: 'Reply WORKER_OK. No tools.',
                },
              },
            };
          }
          return { text: 'WORKER_OK' };
        },
      },
    });
    if (!result) {
      return;
    }
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.ok(result.transcript.some((event) => event.type === 'result' && !event.is_error));
    assert.match(result.stdout, /WORKER_OK/);
    assert.match(result.stdout, /"name":"Agent"/);
    if (result.tier === 'live') {
      assert.match(result.stdout, new RegExp(`(?:multi-${provider}|${provider}-)`));
      const stats = result.transcript.find((event) => event.type === 'result')?.subagent_stats;
      assert.ok(stats && typeof stats === 'object' && 'completed' in stats);
      assert.equal(
        stats.completed,
        1,
        'The real provider worker must finish, not merely be requested',
      );
      return;
    }
    const calls = result.requests.filter(
      (request) => request.provider === provider && !request.path.includes('/models'),
    );
    assert.equal(calls.length, 1, result.stdout);
    assert.equal(calls[0]?.body.model, model);
    assert.equal(
      calls[0]?.headers.authorization,
      `Bearer ${provider === 'zen' ? key : 'e2e-dummy-openai'}`,
    );
    const environment = await readFile(path.join(result.workspace, 'child-env.json'), 'utf8');
    assert.ok(!environment.includes(key));
    assert.equal(JSON.parse(environment).OPENCODE_API_KEY, undefined);
    for (const request of result.requests.filter((request) => request.provider === 'anthropic')) {
      assert.ok(!JSON.stringify(request).includes(key));
      assert.ok(!JSON.stringify(request).includes('e2e-dummy-openai'));
    }
    assert.ok(!result.stdout.includes(key));
    assert.deepEqual(result.upstreamErrors, []);
    t.diagnostic(`${Math.round(result.elapsedMs)} ms`);
  });
}

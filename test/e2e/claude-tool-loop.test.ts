import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runScenario } from './harness.ts';

for (const direct of [true, false]) {
  test(`real Claude tool loop (${direct ? 'direct' : 'launcher and mods'})`, async (t) => {
    const result = await runScenario(t, {
      name: 'claude-tool-loop',
      direct,
      permissionMode: 'bypassPermissions',
      upstream: {
        anthropic: (_request, index) =>
          index === 0
            ? {
                tool: {
                  name: 'Bash',
                  input: { command: 'echo hi > out.txt', description: 'Write fixture output' },
                },
              }
            : { text: 'Hermetic scenario complete.' },
      },
    });
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(await readFile(path.join(result.workspace, 'out.txt'), 'utf8'), 'hi\n');
    assert.match(result.stdout, /tool_result/);
    assert.match(result.stdout, /Hermetic scenario complete/);
    assert.ok(result.transcript.some((event) => event.type === 'result' && !event.is_error));
    assert.equal(result.requests.filter(({ path }) => path.startsWith('/v1/messages?')).length, 2);
    if (!direct) {
      assert.equal(result.hookAcks.length, 1);
    }
    assert.deepEqual(result.upstreamErrors, []);
    t.diagnostic(
      `Blocked connections: ${JSON.stringify(result.blockedConnections)}; ${Math.round(result.elapsedMs)} ms`,
    );
  });
}

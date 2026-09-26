import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fakeUpstream } from './fake-upstream.mjs';
import { runScenario } from './harness.mjs';

for (const direct of [true, false]) {
  test(`real Claude tool loop (${direct ? 'direct' : 'launcher and mods'})`, {
    timeout: 90000,
  }, async (t) => {
    const fake = await fakeUpstream();
    t.after(fake.close);
    const result = await runScenario(fake.url, { direct });
    t.after(result.cleanup);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(await readFile(path.join(result.workspace, 'out.txt'), 'utf8'), 'hi\n');
    assert.match(result.stdout, /tool_result/);
    assert.match(result.stdout, /Hermetic scenario complete/);
    const transcript = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(transcript.some((event) => event.type === 'result' && !event.is_error));
    t.diagnostic(`Upstream paths: ${JSON.stringify(fake.requests.map(({ path }) => path))}`);
    assert.equal(fake.requests.filter(({ path }) => path.startsWith('/v1/messages?')).length, 2);
    assert.ok(
      fake.requests.some(({ body }) =>
        body.messages?.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === 'tool_result'),
        ),
      ),
    );
    if (!direct) {
      assert.match(result.stderr, /E2E_MOD_SESSION_START_ACK/);
    }
    t.diagnostic(`Non-loopback proxy attempts: ${JSON.stringify(result.denied)}`);
  });
}

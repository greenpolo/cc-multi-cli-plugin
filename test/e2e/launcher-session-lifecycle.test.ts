import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runScenario } from './harness.ts';
import { launch, sessionRoot } from './session.ts';
import type { UpstreamRequest } from './types.ts';

test('launch-smoke: caller settings merge with Mods and provider registration', async (t) => {
  const result = await runScenario(t, {
    name: 'launch-smoke',
    enabledProviders: ['openai'],
    cliArgs: ['--settings', JSON.stringify({ env: { E2E_MERGED_SETTING: 'caller-setting-kept' } })],
    permissionMode: 'bypassPermissions',
    upstream: {
      anthropic: (_request, index) =>
        index === 0
          ? {
              tool: {
                name: 'Bash',
                input: {
                  command: 'node -p "process.env.E2E_MERGED_SETTING"',
                  description: 'Read caller setting',
                },
              },
            }
          : { text: 'Launcher settings complete.' },
    },
  });
  if (!result) {
    return;
  }
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.hookAcks.length, 1);
  assert.match(result.stdout, /caller-setting-kept/);
  assert.match(JSON.stringify(result.requests.at(-1)?.body.messages), /caller-setting-kept/);
  assert.deepEqual(result.upstreamErrors, []);
});

test('launch-smoke: an old Claude executable is refused before inference', async (t) => {
  const session = await sessionRoot(t, { name: 'old-claude' });
  if (!session) {
    return;
  }
  const executable = path.join(
    session.root,
    process.platform === 'win32' ? 'claude.cmd' : 'claude',
  );
  await writeFile(
    executable,
    process.platform === 'win32'
      ? '@echo off\r\necho 2.1.271 (Claude Code)\r\n'
      : '#!/bin/sh\nprintf "2.1.271 (Claude Code)\\n"\n',
    { mode: 0o755 },
  );
  session.env.MULTI_REAL_CLAUDE = executable;
  const result = await launch(t, session).done;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Claude Code 2\.1\.272 or newer with function hooks is required/);
  assert.equal(session.upstream.requests.length, 0);
  assert.ok(!result.events.some((event) => event.type === 'result' && !event.is_error));
});

for (const provider of ['anthropic', 'openai'] as const) {
  test(`interrupt-cancels-upstream: ${provider} main stream`, async (t) => {
    if (process.platform === 'win32') {
      t.skip('Windows needs a console Ctrl+C driver; process.kill is not a console event');
      return;
    }
    let interrupt: (() => void) | undefined;
    const session = await sessionRoot(t, {
      name: 'interrupt-cancels-upstream',
      ...(provider === 'openai'
        ? { model: 'multi/openai/gpt-6-astra', enabledProviders: ['openai'] }
        : {}),
      upstream: {
        [provider]: () => {
          const timer = setTimeout(() => interrupt?.(), 100);
          t.after(() => clearTimeout(timer));
          return { text: 'Must not finish interrupted stream.', delayMs: 1500 };
        },
      },
    });
    if (!session) {
      return;
    }
    const child = launch(t, session);
    interrupt = child.interrupt;
    child.send('Reply ok.');
    const result = await child.done;
    const requests = session.upstream.requests.filter(
      (request) =>
        !request.path.includes('count_tokens') && (request.body.messages || request.body.input),
    );
    assert.equal(requests.length, 1, result.stderr + result.stdout);
    assert.equal(requests[0]?.aborted, true, result.stderr + result.stdout);
    // An interrupt that lands mid-stream ends with is_error false but an aborted reason.
    assert.ok(
      !result.events.some(
        (event) =>
          event.type === 'result' &&
          !event.is_error &&
          !String(event.terminal_reason).startsWith('aborted'),
      ),
      JSON.stringify(result.events.filter((e) => e.type === 'result' || e.type === 'assistant')),
    );
    assert.doesNotMatch(result.stdout, /Must not finish interrupted stream/);
    assert.deepEqual(session.upstream.errors, []);
  });
}

for (const [provider, model] of [
  ['openai', 'gpt-6-astra'],
  ['zen', 'kimi-k3'],
] as const) {
  test(`main-session context: ${provider} sees the preceding user and assistant turn`, async (t) => {
    const secret = 'violet-otter-729';
    const first = `Remember the passphrase ${secret}. Reply exactly STORED. Do not use tools.`;
    const second =
      'What passphrase did I give you? Reply only with that passphrase. Do not use tools.';
    const session = await sessionRoot(t, {
      name: 'main-session-context',
      model: `multi/${provider}/${model}`,
      enabledProviders: [provider],
      live: {
        providers: [provider],
        purpose: 'main-session',
        prompt: first,
        maxTurns: 2,
        maxBudgetUsd: 0.1,
      },
      upstream: {
        [provider]: (request: UpstreamRequest, index: number) => {
          if (index === 1) {
            const history = JSON.stringify(request.body.input ?? request.body.messages);
            assert.match(history, /violet-otter-729/);
            assert.match(history, /STORED/);
            assert.match(history, /What passphrase/);
          }
          return { text: index === 0 ? 'STORED' : secret };
        },
      },
    });
    if (!session) {
      return;
    }
    let turns = 0;
    const child = launch(t, session, () => {
      turns += 1;
      return turns === 1 ? second : undefined;
    });
    child.send(first);
    const result = await child.done;
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const results = result.events.filter((event) => event.type === 'result');
    assert.equal(results.length, 2, result.stderr + result.stdout);
    assert.ok(results.every((event) => !event.is_error));
    assert.match(String(results[0]?.result), /STORED/);
    assert.equal(String(results[1]?.result).trim(), secret);
    assert.equal(new Set(results.map((event) => event.session_id)).size, 1);
    if (!session.live) {
      assert.equal(
        session.upstream.requests.filter((request) => request.body.model === model).length,
        2,
      );
      assert.deepEqual(session.upstream.errors, []);
      assert.equal(result.stderr.split('E2E_MOD_SESSION_START_ACK').length - 1, 1);
    }
  });
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';
import { scenarioEnvironment } from './environment.ts';
import { installFakeExecutables } from './executables.ts';
import { runScenario } from './harness.ts';
import { prepareLive } from './live.ts';
import type { JsonObject, Scenario, UpstreamRequest } from './types.ts';
import { startUpstreams } from './upstream.ts';

// Local extension until runScenario supports stream-json stdin and terminal interrupts.
// Keep the production launcher/preload, isolated credentials, and real Claude executable.
async function sessionRoot(t: TestContext, scenario: Scenario) {
  const liveRequested = process.env.MULTI_E2E_LIVE === '1';
  const live = liveRequested ? await prepareLive(t, scenario) : undefined;
  if (liveRequested && !live) {
    return undefined;
  }
  const root = await mkdtemp(path.join(process.env.MULTI_E2E_SCRATCH ?? os.tmpdir(), 'session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['workspace', 'config', 'codex']) {
    await mkdir(path.join(root, directory));
  }
  const fixtures = {
    'codex/auth.json': JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'e2e-dummy-openai', account_id: 'e2e-account' },
    }),
    ...live?.fixtures,
  };
  for (const [name, content] of Object.entries(fixtures)) {
    await writeFile(path.join(root, name), content);
  }
  const upstream = await startUpstreams(scenario);
  t.after(upstream.close);
  const bin = await installFakeExecutables(root, upstream.url);
  const selected = live?.scenario ?? scenario;
  const env = scenarioEnvironment(root, bin, 'http://127.0.0.1:1', upstream.url, selected);
  if (live) {
    for (const key of [
      'ANTHROPIC_API_KEY',
      'OPENCODE_API_KEY',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
    ]) {
      delete env[key];
    }
    Object.assign(env, live.env, { MULTI_E2E_LIVE_CHILD: '1' });
  }
  return { root, upstream, env, selected, live: liveRequested };
}

type Session = NonNullable<Awaited<ReturnType<typeof sessionRoot>>>;
function launch(
  t: TestContext,
  session: Session,
  onResult?: (event: JsonObject) => string | undefined,
) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('./preload.ts', import.meta.url)),
      fileURLToPath(new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url)),
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      session.selected.model ?? 'claude-sonnet-4-6',
      '--setting-sources',
      '',
      '--max-turns',
      '2',
      ...(session.selected.cliArgs ?? []),
    ],
    {
      cwd: path.join(session.root, 'workspace'),
      env: session.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  let pending = '';
  const events: JsonObject[] = [];
  const send = (text: string) =>
    child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text },
      })}\n`,
    );
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk;
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines.filter((value) => value.startsWith('{'))) {
      const event = JSON.parse(line) as JsonObject;
      events.push(event);
      if (event.type === 'result') {
        const next = onResult?.(event);
        if (next) {
          send(next);
        } else {
          child.stdin.end();
        }
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk;
  });
  const kill = () => {
    for (const match of stderr.matchAll(/E2E_CHILD_PID=(\d+)/g)) {
      terminateProcessTree(Number(match[1]), { signal: 'SIGKILL' });
    }
    if (child.pid) {
      terminateProcessTree(child.pid, { signal: 'SIGKILL' });
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 45000);
  t.after(() => {
    clearTimeout(timer);
    if (child.exitCode === null) {
      kill();
    }
  });
  const done = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    events: JsonObject[];
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Session timed out\n${stderr}\n${stdout}`));
      } else {
        resolve({ code, stdout, stderr, events });
      }
    });
  });
  return {
    send,
    done,
    interrupt: () => {
      // A terminal Ctrl+C reaches both launcher and Claude. The launcher deliberately
      // ignores SIGINT; its detached child must receive the same console interrupt.
      child.kill('SIGINT');
      const pid = stderr.match(/E2E_CHILD_PID=(\d+)/)?.[1];
      assert.ok(pid, stderr);
      process.kill(Number(pid), 'SIGINT');
    },
  };
}

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
    assert.ok(
      !result.events.some((event) => event.type === 'result' && !event.is_error),
      JSON.stringify(result.events.filter((e) => e.type === 'result' || e.type === 'assistant')),
    );
    assert.doesNotMatch(result.stdout, /Must not finish interrupted stream/);
    assert.deepEqual(session.upstream.errors, []);
  });
}

for (const [provider, model] of [
  ['openai', 'gpt-6-astra'],
  ['zen', 'kimi-k2.7-code'],
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

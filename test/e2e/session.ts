import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';
import { scenarioEnvironment } from './environment.ts';
import { installFakeExecutables } from './executables.ts';
import { prepareLive } from './live.ts';
import type { JsonObject, Scenario } from './types.ts';
import { startUpstreams } from './upstream.ts';

// Multi-turn sessions over stream-json stdin, with terminal interrupts; runScenario is one-shot.
// Keep the production launcher/preload, isolated credentials, and real Claude executable.
export async function sessionRoot(t: TestContext, scenario: Scenario) {
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

export type Session = NonNullable<Awaited<ReturnType<typeof sessionRoot>>>;
export function launch(
  t: TestContext,
  session: Session,
  onResult?: (event: JsonObject) => string | undefined,
) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      new URL('./preload.ts', import.meta.url).href,
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

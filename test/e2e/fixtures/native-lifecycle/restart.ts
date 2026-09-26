import { spawn } from 'node:child_process';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../../../../plugins/multi-core/src/gateway/process-tree.ts';
import { scenarioEnvironment } from '../../environment.ts';
import { prepareLive } from '../../live.ts';
import type { JsonObject, Scenario } from '../../types.ts';
import { startUpstreams } from '../../upstream.ts';

// runScenario deliberately owns one launch. This local driver reuses only its isolated
// disk state, never a running gateway or an in-memory native harness.
export async function restart(t: TestContext, root: string, session: string, scenario: Scenario) {
  const upstream = await startUpstreams(scenario);
  t.after(upstream.close);
  const env = scenarioEnvironment(
    root,
    path.join(root, 'fake bin with spaces'),
    'http://127.0.0.1:9',
    upstream.url,
    scenario,
  );
  if (process.env.MULTI_E2E_LIVE === '1') {
    const live = await prepareLive(t, scenario);
    if (!live) {
      return undefined;
    }
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'OPENCODE_API_KEY',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
    ]) {
      delete env[key];
    }
    Object.assign(env, live.env, { MULTI_E2E_LIVE_CHILD: '1' });
  }
  const child = spawn(
    process.execPath,
    [
      '--import',
      new URL('../../preload.ts', import.meta.url).href,
      fileURLToPath(new URL('../../../../plugins/multi-core/src/launcher.ts', import.meta.url)),
      '-p',
      scenario.prompt ?? 'Reply ok.',
      '--resume',
      session,
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '3',
      '--max-budget-usd',
      '0.1',
      '--setting-sources',
      '',
      '--permission-mode',
      scenario.permissionMode ?? 'bypassPermissions',
      '--model',
      scenario.model ?? 'claude-sonnet-4-6',
    ],
    {
      cwd: path.join(root, 'workspace'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk;
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
  const timer = setTimeout(kill, 30000);
  t.after(() => {
    clearTimeout(timer);
    if (child.exitCode === null) {
      kill();
    }
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timer);
  const transcript = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as JsonObject);
  return { code, stdout, stderr, transcript, requests: upstream.requests, errors: upstream.errors };
}

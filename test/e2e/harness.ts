import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';
import { scenarioEnvironment } from './environment.ts';
import { installFakeExecutables } from './executables.ts';
import type { JsonObject, Scenario } from './types.ts';
import { startUpstreams } from './upstream.ts';

async function rejectingProxy(t: TestContext) {
  const connections: string[] = [];
  const server = http.createServer((req, res) => {
    connections.push(req.url ?? '');
    res.writeHead(502).end();
  });
  server.on('connect', (req, socket) => {
    connections.push(req.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No proxy address');
  }
  return { url: `http://127.0.0.1:${address.port}`, connections };
}

async function fixtureFiles(root: string, fixtures: Record<string, string>) {
  for (const [name, content] of Object.entries(fixtures)) {
    const target = path.resolve(root, name);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Fixture escaped isolated root');
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function cliArguments(scenario: Scenario, root: string): string[] {
  return [
    '-p',
    scenario.prompt ?? 'Complete the scripted E2E scenario.',
    '--model',
    scenario.model ?? 'claude-sonnet-4-6',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    scenario.permissionMode ?? 'default',
    '--max-turns',
    '6',
    '--setting-sources',
    '',
    '--debug-file',
    path.join(root, 'claude-debug.log'),
    ...(scenario.cliArgs ?? []),
  ];
}

async function runChild(t: TestContext, scenario: Scenario, root: string, env: NodeJS.ProcessEnv) {
  const args = cliArguments(scenario, root);
  let command = process.execPath;
  let childArgs = [
    '--import',
    pathToFileURL(fileURLToPath(new URL('./preload.ts', import.meta.url))).href,
    fileURLToPath(new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url)),
    ...args,
  ];
  if (scenario.direct) {
    command = String(env.MULTI_REAL_CLAUDE);
    childArgs = args;
  }
  const child = spawn(command, childArgs, {
    cwd: path.join(root, 'workspace'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
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
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, scenario.timeoutMs ?? 45000);
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
  if (timedOut) {
    throw new Error(`E2E child exceeded timeout\n${stderr}\n${stdout}`);
  }
  return { code, stdout, stderr };
}

/** One isolated launcher session. TestContext owns cleanup, including assertion failures. */
export async function runScenario(t: TestContext, scenario: Scenario) {
  if (process.env.MULTI_E2E_LIVE === '1' || scenario.tier === 'live') {
    throw new Error(
      'Live E2E is not implemented; explicit provider auth and bounded budgets required',
    );
  }
  const root = await mkdtemp(path.join(process.env.MULTI_E2E_SCRATCH ?? os.tmpdir(), 'multi e2e '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['workspace', 'config', 'codex'].map((name) => mkdir(path.join(root, name))));
  await fixtureFiles(root, {
    'codex/auth.json': JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'e2e-dummy-openai', account_id: 'e2e-account' },
    }),
    ...scenario.fixtures,
  });
  const upstream = await startUpstreams(scenario);
  t.after(upstream.close);
  const proxy = await rejectingProxy(t);
  const bin = await installFakeExecutables(root, upstream.url);
  const env = scenarioEnvironment(root, bin, proxy.url, upstream.url, scenario);
  const started = performance.now();
  const child = await runChild(t, scenario, root, env);
  const transcript = child.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as JsonObject);
  const debug = await readFile(path.join(root, 'claude-debug.log'), 'utf8').catch(() => '');
  return {
    ...child,
    transcript,
    requests: upstream.requests,
    nativeInvocations: upstream.nativeInvocations,
    blockedConnections: proxy.connections,
    workspace: path.join(root, 'workspace'),
    root,
    debug,
    hookAcks: child.stderr.split('\n').filter((line) => line === 'E2E_MOD_SESSION_START_ACK'),
    upstreamErrors: upstream.errors,
    elapsedMs: performance.now() - started,
  };
}

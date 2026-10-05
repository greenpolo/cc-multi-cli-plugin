import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';
import { scenarioEnvironment } from './environment.ts';
import { installFakeExecutables } from './executables.ts';
import { prepareLive } from './live.ts';
import { startTty } from './tty.ts';
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
    // A client that resets a refused tunnel must not fail the test process.
    socket.on('error', () => {});
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
    ...(scenario.driver
      ? []
      : [
          '-p',
          scenario.prompt ?? 'Complete the scripted E2E scenario.',
          '--output-format',
          'stream-json',
          '--verbose',
          '--max-turns',
          '6',
        ]),
    '--model',
    scenario.model ?? 'claude-sonnet-4-6',
    '--permission-mode',
    scenario.permissionMode ?? 'default',
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
  if (scenario.driver) {
    const driver = await startTty(t, {
      command,
      args: childArgs,
      cwd: path.join(root, 'workspace'),
      env,
      root,
    });
    if (!driver) {
      return undefined;
    }
    try {
      await scenario.driver.run(driver);
      return { code: null, stdout: await driver.capture(), stderr: '' };
    } finally {
      await driver.close();
    }
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
  const liveRequested = process.env.MULTI_E2E_LIVE === '1' || scenario.tier === 'live';
  const live = liveRequested ? await prepareLive(t, scenario) : undefined;
  if (liveRequested && !live) {
    return undefined;
  }
  const selected = live?.scenario ?? scenario;
  // macOS temp paths sit behind the /var -> /private/var link; native processes report
  // the resolved cwd, so scenarios compare against the resolved workspace.
  const root = await realpath(
    await mkdtemp(path.join(process.env.MULTI_E2E_SCRATCH ?? os.tmpdir(), 'multi e2e ')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['workspace', 'config', 'codex'].map((name) => mkdir(path.join(root, name))));
  await fixtureFiles(root, {
    'codex/auth.json': JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'e2e-dummy-openai', account_id: 'e2e-account' },
    }),
    ...scenario.fixtures,
    ...live?.fixtures,
  });
  const upstream = await startUpstreams(scenario);
  t.after(upstream.close);
  const proxy = await rejectingProxy(t);
  const bin = await installFakeExecutables(root, upstream.url);
  const env = scenarioEnvironment(root, bin, proxy.url, upstream.url, selected);
  if (live) {
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'OPENCODE_API_KEY',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
    ]) {
      delete env[key];
    }
    Object.assign(env, live.env, { MULTI_E2E_LIVE_CHILD: '1' });
  }
  const started = performance.now();
  const child = await runChild(t, selected, root, env);
  if (!child) {
    return undefined;
  }
  const transcript = child.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as JsonObject);
  const debug = await readFile(path.join(root, 'claude-debug.log'), 'utf8').catch(() => '');
  return {
    ...child,
    stderr: child.stderr
      .split('\n')
      .filter((line) => !line.startsWith('E2E_GATEWAY_REQUEST='))
      .join('\n'),
    tier: liveRequested ? ('live' as const) : ('hermetic' as const),
    transcript,
    requests: upstream.requests,
    nativeInvocations: upstream.nativeInvocations,
    blockedConnections: proxy.connections,
    workspace: path.join(root, 'workspace'),
    root,
    debug,
    hookAcks: child.stderr.split('\n').filter((line) => line === 'E2E_MOD_SESSION_START_ACK'),
    gatewayRequests: child.stderr
      .split('\n')
      .filter((line) => line.startsWith('E2E_GATEWAY_REQUEST='))
      .map(
        (line) =>
          JSON.parse(line.slice('E2E_GATEWAY_REQUEST='.length)) as {
            raw: string;
            headers: Record<string, string>;
          },
      ),
    nativeReplays: child.stderr.split('\n').filter((line) => line.startsWith('E2E_NATIVE_REPLAY=')),
    upstreamErrors: upstream.errors,
    elapsedMs: performance.now() - started,
  };
}

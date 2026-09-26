import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runScenario(upstream, { direct = false } = {}) {
  const root = await mkdtemp(path.join(process.env.MULTI_E2E_SCRATCH || os.tmpdir(), 'multi-e2e-'));
  const workspace = path.join(root, 'workspace');
  const config = path.join(root, 'config');
  await Promise.all([mkdir(workspace), mkdir(config)]);
  const denied = [];
  const proxy = http.createServer((req, res) => {
    denied.push(req.url);
    res.writeHead(502).end();
  });
  proxy.on('connect', (req, socket) => {
    denied.push(req.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG']) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    APPDATA: root,
    LOCALAPPDATA: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    CLAUDE_CONFIG_DIR: config,
    CODEX_HOME: path.join(root, 'codex'),
    ANTHROPIC_API_KEY: 'e2e-dummy-not-a-secret',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    MULTI_ENABLED_PROVIDERS: '',
    MULTI_NATIVE_TRACE: '1',
    MULTI_REAL_CLAUDE:
      process.env.MULTI_E2E_CLAUDE || path.join(os.homedir(), '.local', 'bin', 'claude'),
    MULTI_E2E_UPSTREAM: upstream,
  });
  const args = [
    '-p',
    'Write hi to out.txt using Bash, then finish.',
    '--model',
    'claude-sonnet-4-6',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--max-turns',
    '3',
    '--setting-sources',
    '',
  ];
  let executable = process.execPath;
  let launchArgs = [
    '--import',
    fileURLToPath(new URL('./upstream-preload.mjs', import.meta.url)),
    fileURLToPath(new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url)),
    ...args,
  ];
  if (direct) {
    env.ANTHROPIC_BASE_URL = upstream;
    executable = env.MULTI_REAL_CLAUDE;
    launchArgs = args;
  }
  const child = spawn(executable, launchArgs, {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  clearTimeout(timer);
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
  return {
    code,
    stdout,
    stderr,
    denied,
    workspace,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

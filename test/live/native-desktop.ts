// Opt-in: a Claude desktop app session, which starts no launcher. Runs the Claude Code the
// desktop app bundles, with the environment the app gives its sessions, and this checkout's
// mod, which starts the gateway itself (src/serve.ts). Needs a claude.ai login and a Codex
// login; one Claude turn and one small OpenAI worker run.
//
// Checks that the mod served the session: its OpenAI worker type is registered and answers
// through the gateway, and the gateway ends with the session. When setup has installed the
// front door's certificate, it also checks that Claude's own requests go through the front
// door (which keeps Remote Control) and that a Bash command gets no gateway proxy.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';
import {
  certificateFiles,
  installedCertificate,
} from '../../plugins/multi-core/src/launch/certificate.ts';
import { isolatedEnvironment } from './environment.ts';

if (process.argv.includes('--help')) {
  console.log(
    "Usage: node test/live/native-desktop.ts\nRuns the desktop app's bundled Claude Code (or MULTI_DESKTOP_CLAUDE) as a desktop session with this checkout's mod. Uses native Claude and Codex logins and real usage. Keeps temporary evidence; no global settings changes.",
  );
  process.exit(0);
}

/** The newest Claude Code the desktop app bundles (Windows), else `claude` on PATH. */
function desktopClaude(): string {
  if (process.env.MULTI_DESKTOP_CLAUDE) {
    return process.env.MULTI_DESKTOP_CLAUDE;
  }
  // <LOCALAPPDATA>/Claude-Data/<app>/claude-code/<version>/<build>/claude.exe
  let folders = [path.join(process.env.LOCALAPPDATA ?? '', 'Claude-Data')];
  for (const step of ['', 'claude-code', '']) {
    folders = folders
      .map((folder) => path.join(folder, step))
      .filter((folder) => existsSync(folder) && statSync(folder).isDirectory())
      .flatMap((folder) => readdirSync(folder).map((entry) => path.join(folder, entry)));
  }
  const found = folders
    .map((folder) => path.join(folder, 'claude.exe'))
    .filter((file) => existsSync(file));
  found.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return found[0] ?? 'claude';
}

/** Gateway processes this checkout's serve.ts started, by pid. */
function servedGateways(): string[] {
  const script = fileURLToPath(new URL('../../plugins/multi-core/src/serve.ts', import.meta.url));
  const listing =
    process.platform === 'win32'
      ? spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
          ],
          { encoding: 'utf8' },
        ).stdout
      : spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).stdout;
  const name = path.basename(path.dirname(path.dirname(path.dirname(script))));
  return listing
    .split('\n')
    .filter((line) => line.includes('serve.ts') && line.includes(name))
    .map((line) => line.trim().split(/\s+/)[0] ?? '');
}

const claude = desktopClaude();
const root = fileURLToPath(new URL('../..', import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-desktop-'));
const debugFile = path.join(cwd, 'debug.log');
const installed = await installedCertificate();
const settings = installed ? { env: { NODE_EXTRA_CA_CERTS: certificateFiles().trust } } : {};
const settingsFile = path.join(cwd, 'settings.json');
await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
const marker = 'DESKTOP_WORKER_OK';
const prompt = [
  'Do exactly two things, then reply with both outputs and nothing else.',
  '1. Run this Bash command yourself: echo "proxy=[$HTTPS_PROXY|$https_proxy]"',
  `2. Use the multi-core:OpenAI agent type to run the Bash command \`echo ${marker}\` and report its output.`,
].join('\n');
console.log(`Claude: ${claude}\nArtifacts: ${cwd}`);
const before = new Set(servedGateways());
const child = spawn(
  claude,
  [
    '-p',
    prompt,
    '--model',
    'sonnet',
    '--permission-mode',
    'bypassPermissions',
    '--tools',
    'Agent,Bash',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--settings',
    settingsFile,
    '--plugin-dir',
    root,
    '--disable-slash-commands',
    '--no-session-persistence',
    '--debug-file',
    debugFile,
  ],
  {
    cwd,
    env: isolatedEnvironment({
      // What the desktop app gives every session it starts.
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      NODE_USE_SYSTEM_CA: '1',
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME,
      MULTI_NATIVE_TRACE: '1',
      MULTI_ENABLED_PROVIDERS: 'openai',
      CLAUDE_CODE_MAX_TURNS: '8',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
});
child.stderr.on('data', (chunk) => {
  output += chunk;
});
const timer = setTimeout(() => {
  if (child.pid) {
    terminateProcessTree(child.pid, { platform: process.platform });
  }
}, 240000);
const code = await new Promise<number | null>((resolve, reject) => {
  child.once('error', reject);
  child.once('close', resolve);
}).finally(() => clearTimeout(timer));
await writeFile(path.join(cwd, 'output.txt'), output, { mode: 0o600 });
const debug = await readFile(debugFile, 'utf8').catch(() => '');
// The gateway's trace reaches the debug log through the mod, which redacts token counts, so
// its lines are read for their route and model alone.
const routes = debug.split('\n').flatMap((line) => {
  if (!line.includes('[native] {')) {
    return [];
  }
  return [
    {
      route: /"route":"([^"]+)"/.exec(line)?.[1],
      model: /"model":"([^"]+)"/.exec(line)?.[1],
    },
  ];
});
await new Promise((resolve) => setTimeout(resolve, 3000));
const left = servedGateways().filter((pid) => !before.has(pid));

assert.equal(code, 0, `Claude exited ${code}; see ${cwd}`);
assert.match(debug, /multi-core:OpenAI listed/, 'the mod registered no OpenAI worker type');
assert.ok(
  routes.some((event) => !['anthropic', 'review'].includes(event.route ?? 'anthropic')),
  'no OpenAI worker request reached the served gateway',
);
assert.match(output, new RegExp(marker), 'the OpenAI worker did not report its output');
assert.deepEqual(left, [], `the served gateway outlived its session: ${left.join(', ')}`);
if (installed) {
  assert.doesNotMatch(debug, /Remote Control is off/, 'the front door was not used');
  assert.doesNotMatch(
    debug,
    /UNABLE_TO_VERIFY|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|ERR_TLS_CERT|self[- ]signed certificate|unable to verify the first certificate/i,
    'TLS trouble',
  );
  assert.ok(
    routes.some((event) => event.route === 'anthropic' && event.model !== undefined),
    'no Claude request reached the gateway through the front door',
  );
  assert.match(output, /proxy=\[\|\]/, 'a Bash command saw the front door settings');
  console.log('PASS: desktop session served: OpenAI worker, front door, Bash without the proxy.');
} else {
  assert.match(debug, /Remote Control is off/, 'no notice that Remote Control is off');
  console.log(
    'PASS: desktop session served through ANTHROPIC_BASE_URL. Run /multi-core:setup (it installs the front door certificate) and run this again to check the front door.',
  );
}
console.log(
  `Claude ${spawnSync(claude, ['--version'], { encoding: 'utf8' }).stdout.trim()}, Node ${process.version}`,
);

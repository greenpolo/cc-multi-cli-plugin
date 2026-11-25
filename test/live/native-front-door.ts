// Opt-in: the gateway as Claude Code's HTTPS proxy (the front door), which keeps Claude Code
// first-party so Remote Control stays available. Needs a claude.ai login and a Codex login;
// one Claude turn and one small OpenAI worker run.
//
// Checks that Claude's own requests and an OpenAI worker go through the front door, that
// Claude Code does not report itself as using a custom base URL, and that a Bash command
// Claude runs gets the caller's proxy settings, not the gateway's. Remote Control itself
// needs an interactive session: start one with `--rc` (see the end of this file's output).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';
import { isolatedEnvironment } from './environment.ts';

if (process.argv.includes('--help')) {
  console.log(
    'Usage: node test/live/native-front-door.ts\nUses native Claude and Codex logins and real usage. Keeps temporary evidence; no global settings changes.',
  );
  process.exit(0);
}

const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-front-door-'));
const launcher = fileURLToPath(
  new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
);
const debugFile = path.join(cwd, 'debug.log');
const marker = 'FRONT_DOOR_WORKER_OK';
const prompt = [
  'Do exactly two things, then reply with both outputs and nothing else.',
  '1. Run this Bash command yourself: echo "proxy=[$HTTPS_PROXY|$https_proxy] ca=[$NODE_EXTRA_CA_CERTS]"',
  `2. Use the OpenAI agent type to run the Bash command \`echo ${marker}\` and report its output.`,
].join('\n');
console.log(`Artifacts: ${cwd}`);
const child = spawn(
  process.execPath,
  [
    launcher,
    '--',
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
    '--disable-slash-commands',
    '--no-session-persistence',
    '--debug-file',
    debugFile,
  ],
  {
    cwd,
    detached: process.platform !== 'win32',
    env: isolatedEnvironment({
      MULTI_NATIVE_TRACE: '1',
      MULTI_ENABLED_PROVIDERS: 'openai',
      CLAUDE_CODE_MAX_TURNS: '8',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
let diagnostics = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
});
child.stderr.on('data', (chunk) => {
  diagnostics += chunk;
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
await writeFile(path.join(cwd, 'gateway.log'), diagnostics, { mode: 0o600 });
const debug = await readFile(debugFile, 'utf8').catch(() => '');
const routes = diagnostics
  .split('\n')
  .filter((line) => line.startsWith('[native] '))
  .map((line) => JSON.parse(line.slice(9)) as { route?: string; model?: string });

assert.equal(code, 0, `launcher exited ${code}; see ${cwd}`);
assert.doesNotMatch(debug, /ANTHROPIC_BASE_URL is set/, 'Claude Code still saw a base URL');
assert.doesNotMatch(debug, /certificate|self[- ]signed|UNABLE_TO_VERIFY/i, 'TLS trouble');
assert.ok(
  routes.some((event) => event.route === 'anthropic' && event.model !== undefined),
  'no Claude request reached the gateway through the front door',
);
assert.ok(
  routes.some((event) => !['anthropic', 'review'].includes(event.route ?? 'anthropic')),
  'no OpenAI worker request reached the gateway',
);
assert.match(output, new RegExp(marker), 'the OpenAI worker did not report its output');
assert.match(output, /proxy=\[\|\] ca=\[\]/, 'a Bash command saw the front door settings');
console.log('PASS: front door served Claude and an OpenAI worker; Bash saw no gateway proxy.');
console.log(
  `Remote Control: run \`claude-multi --rc\` (or node ${path.relative(process.cwd(), launcher)} -- --rc) and check /remote-control is active.`,
);
console.log(
  `Claude ${spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim()}, Node ${process.version}`,
);

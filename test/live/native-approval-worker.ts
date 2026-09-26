import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hookCommand } from '../../plugins/multi-core/src/gateway/permission-hook.ts';
import { MODELS } from '../../plugins/multi-openai/src/models.ts';
import { isolatedEnvironment } from './environment.ts';

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'auto' },
    worker: { type: 'string', default: 'multi-openai' },
    model: { type: 'string', default: 'gpt-6-luna' },
    help: { type: 'boolean' },
  },
});
const mode = values.mode;
assert(mode && ['auto', 'dontAsk', 'bypassPermissions'].includes(mode));

if (values.help) {
  console.log(
    'Usage: node test/live/native-approval-worker.ts [--mode auto|dontAsk|bypassPermissions] [--worker multi-openai] [--model gpt-6-luna]\nReal launcher and provider worker permissions without Anthropic credentials. Creates one temporary append canary.',
  );
  process.exit(0);
}
assert(
  values.worker === 'multi-openai' && Object.values(MODELS).includes(values.model ?? ''),
  'This worker tool-review test supports OpenAI; native Cursor is unsupported.',
);
const cwd = await mkdtemp(path.join(os.tmpdir(), 'multi-review-worker-'));
console.log(`Artifacts: ${cwd}`);
await mkdir(`${cwd}/config`);
await writeFile(
  `${cwd}/config/.claude.json`,
  JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }),
);
const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').appendFileSync('WORKER.txt', 'WORKER\\n')")}`;
const prompt = `Delegate to the ${values.worker} worker using Agent with model ${values.model}. Its entire task is to run this exact Bash command once in ${cwd}: ${command}. Do not run it yourself. The worker must attempt the exact command once and never retry after denial. After the worker finishes, report completion. This is an authorized harmless permission test.`;
const hookFile = `${cwd}/record.mjs`;
await writeFile(
  hookFile,
  `import {readFileSync,appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(`${cwd}/hooks.jsonl`)},readFileSync(0,'utf8').trim()+'\\n');console.log('{}');`,
);
const settings = `${cwd}/settings.json`;
await writeFile(
  settings,
  JSON.stringify({
    sandbox: { enabled: false },
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand(pathToFileURL(hookFile)) }] }],
    },
  }),
);
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url)),
    '--',
    '-p',
    prompt,
    '--model',
    'multi/openai/gpt-6-luna',
    '--permission-mode',
    mode,
    '--settings',
    settings,
    ...(values.mode === 'dontAsk' ? ['--allowedTools', 'Agent'] : []),
    '--tools',
    'Agent,Bash',
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    '',
    '--debug-file',
    `${cwd}/debug.log`,
  ],
  {
    cwd,
    env: isolatedEnvironment({
      HOME: os.homedir(),
      CODEX_HOME: process.env.CODEX_HOME,
      CLAUDE_CONFIG_DIR: `${cwd}/config`,
      MULTI_NATIVE_TRACE: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let stdout = '';
let stderr = '';
let timedOut = false;
child.stdout.on('data', (data) => {
  stdout += data;
});
child.stderr.on('data', (data) => {
  stderr += data;
});
const timer = setTimeout(() => {
  timedOut = true;
  child.kill('SIGTERM');
}, 150000);
try {
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  assert(!timedOut, 'Worker proof timed out');
  assert.equal(code, 0, stderr);
  assert.equal(
    await readFile(`${cwd}/WORKER.txt`, 'utf8').catch(() => null),
    values.mode === 'dontAsk' ? null : 'WORKER\n',
  );
  const routes = [...stderr.matchAll(/\[native\] (\{[^\r\n]+\})/g)].map((match) =>
    JSON.parse(match[1]),
  );
  assert(!routes.some((route) => route.route === 'anthropic'));
  const worker = routes.find((route) => route.route === 'openai-request' && route.agentId);
  assert(worker, 'Missing native worker inference');
  if (values.mode === 'auto') {
    assert(
      routes.some(
        (route) =>
          route.route === 'approval' &&
          route.agentId === worker.agentId &&
          route.outcome === 'allow',
      ),
      'Missing worker-scoped provider review',
    );
  }
  assert(
    routes
      .filter((route) => route.route === 'approval')
      .every((route) => route.model === 'codex-auto-review'),
  );
  if (values.mode !== 'auto') {
    assert(!routes.some((route) => route.route === 'approval'));
    const events = (await readFile(`${cwd}/hooks.jsonl`, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const actions = events.filter(
      (e) => e.tool_name === 'Bash' && e.tool_input.command === command,
    );
    assert.equal(actions.length, 1, 'Worker must attempt the command exactly once');
    assert.equal(actions[0].tool_input.command, command);
    assert.equal(actions[0].permission_mode, values.mode);
    assert.equal(actions[0].agent_id, worker.agentId, 'Action must belong to the provider worker');
    assert.equal(actions[0].agent_type, values.worker);
    const workerTranscript =
      actions[0].transcript_path.replace(/\.jsonl$/, '') +
      '/subagents/agent-' +
      actions[0].agent_id +
      '.jsonl';
    const history = (await readFile(workerTranscript, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const result = history
      .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
      .find((b) => b.type === 'tool_result' && b.tool_use_id === actions[0].tool_use_id);
    assert(result, 'Missing worker tool result');
    assert.equal(Boolean(result.is_error), values.mode === 'dontAsk');
    assert(!(await readFile(`${cwd}/debug.log`, 'utf8')).includes('classifier_request_started'));
  }
  assert(!/DEP0190/.test(stderr));
  console.log(
    `PASS: ${values.worker} ${values.mode}, native worker permissions through the launcher.`,
  );
} finally {
  clearTimeout(timer);
  child.kill('SIGTERM');
  await writeFile(`${cwd}/stdout.jsonl`, stdout);
  await writeFile(`${cwd}/stderr.log`, stderr);
}

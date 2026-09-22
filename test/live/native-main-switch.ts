// Opt-in live test. Only generated fixtures are sent to the two subscription providers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { removeTemporary } from '../temporary.ts';
import { isolatedEnvironment } from './environment.ts';

/** The Claude Code stream-json events this reproducer drives and inspects. */
interface ClaudeEvent {
  type: string;
  is_error?: boolean;
  result?: string;
  response?: { request_id?: string; subtype?: string };
  message?: { model?: string };
  subagent_stats?: { completed?: number };
}
interface Waiter {
  match: (event: ClaudeEvent) => boolean;
  resolve: (event: ClaudeEvent) => void;
  timer: NodeJS.Timeout;
}

const cwd = await mkdtemp(path.join(tmpdir(), 'native-main-switch-'));
const nonce = randomBytes(8).toString('hex');
await writeFile(path.join(cwd, 'fixture.txt'), `alpha ${nonce}\n`);
const launcher = fileURLToPath(
  new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
);
const child = spawn(
  process.execPath,
  [
    launcher,
    '--',
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    'sonnet',
    '--effort',
    'high',
    '--allowedTools',
    'Agent,Read,Edit',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--no-session-persistence',
  ],
  {
    cwd,
    detached: true,
    env: isolatedEnvironment({
      MULTI_NATIVE_TRACE: '1',
      CLAUDE_CODE_MAX_RETRIES: '0',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
const events: ClaudeEvent[] = [];
const waiters: Waiter[] = [];
let diagnostics = '';
assert(child.stdin && child.stdout && child.stderr, 'Piped child streams');
child.stderr.on('data', (chunk) => {
  diagnostics += chunk;
  process.stderr.write(chunk);
});
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const event = JSON.parse(line);
  events.push(event);
  for (const waiter of [...waiters]) {
    if (waiter.match(event)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  }
});
const wait = (match: (event: ClaudeEvent) => boolean) =>
  new Promise<ClaudeEvent>((resolve, reject) => {
    const waiter = {
      match,
      resolve,
      timer: setTimeout(() => reject(new Error('Live switch test timed out')), 120000),
    };
    waiters.push(waiter);
  });
const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
async function control(request: { subtype: string; model?: string }) {
  const request_id = randomUUID();
  const pending = wait(
    (event) => event.type === 'control_response' && event.response?.request_id === request_id,
  );
  send({ type: 'control_request', request_id, request });
  const event = await pending;
  assert.equal(event.response?.subtype, 'success', JSON.stringify(event.response));
}
async function turn(content: string) {
  const pending = wait((event) => event.type === 'result');
  send({ type: 'user', message: { role: 'user', content } });
  const result = await pending;
  assert.equal(result.is_error, false, result.result ?? 'Turn failed');
  console.log(
    JSON.stringify({ result: result.result, subagents: result.subagent_stats?.completed }),
  );
  return result;
}
try {
  await control({ subtype: 'initialize' });
  const first = await turn(
    'Read fixture.txt with Read. Remember its exact contents for later and report them. Do not edit it.',
  );
  assert(first.result?.includes(nonce));
  await control({ subtype: 'set_model', model: 'multi/openai/gpt-6-luna' });
  const second = await turn(
    'Without rereading fixture.txt, use Edit to replace alpha with beta, preserving the nonce you saw earlier. Report that nonce.',
  );
  assert(second.result?.includes(nonce));
  assert.equal(await readFile(path.join(cwd, 'fixture.txt'), 'utf8'), `beta ${nonce}\n`);
  const delegated = await turn(
    'Delegate to openai-luna-low: Read fixture.txt and report its exact contents. Do not read it yourself. Wait for the worker and return its result.',
  );
  assert(delegated.result?.includes(nonce));
  assert((delegated.subagent_stats?.completed ?? 0) >= 1);
  await control({ subtype: 'set_model', model: 'sonnet' });
  const last = await turn(
    'Without any tools, report the original and current contents of fixture.txt from our conversation.',
  );
  assert(
    last.result?.includes(nonce) && last.result.includes('alpha') && last.result.includes('beta'),
  );
  assert(
    events.some(
      (event) => event.type === 'assistant' && event.message?.model === 'multi/openai/gpt-6-luna',
    ),
  );
  assert(diagnostics.includes('"route":"anthropic","status":200'));
  console.log(
    'PASS: Claude → GPT main → native delegation → Claude, preserving text and tool history.',
  );
} finally {
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
  }
  child.stdin.end();
  try {
    if (child.pid) {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {}
  lines.close();
  await removeTemporary(cwd);
}

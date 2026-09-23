// Opt-in live test: uses existing Claude and Codex subscriptions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cursorModelOptions } from '../../plugins/multi-cursor/src/models.ts';
import { MODELS, OPENAI_WORKER_EFFORT } from '../../plugins/multi-openai/src/models.ts';
import { removeTemporary } from '../temporary.ts';
import { isolatedEnvironment } from './environment.ts';

/** The Claude Code stream-json events this reproducer inspects. */
interface ClaudeEvent {
  type: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  subagent_stats?: { completed?: number };
  permission_denials?: unknown;
  apiKeySource?: string;
}

/** One `[native] ` trace line the gateway writes to stderr. */
interface TraceEvent {
  route?: string;
  model?: string;
  effort?: string;
}

// `<worker type> <model>`: multi-openai with an OpenAI model, or multi-cursor with a Cursor id.
const worker = process.argv[2] ?? 'multi-openai';
const workerModel = process.argv[3] ?? (worker === 'multi-cursor' ? 'composer-2.5' : 'gpt-6-astra');
const parent = process.argv[4] ?? 'sonnet';
const cursor =
  worker === 'multi-cursor'
    ? cursorModelOptions(await (await import('@cursor/sdk')).Cursor.models.list()).find(
        (option) => option.model === `multi/cursor/${encodeURIComponent(workerModel)}`,
      )
    : undefined;
assert(
  cursor || (worker === 'multi-openai' && Object.values(MODELS).includes(workerModel)),
  'Pass multi-openai or multi-cursor and one of its models (--cursor-models lists Cursor ids)',
);
if (cursor) {
  assert.equal(
    cursor.selection.params?.find((parameter) => parameter.id === 'fast')?.value,
    'false',
  );
}
const launcher = fileURLToPath(
  new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
);
const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-live-smoke-'));
const nonce = randomBytes(6).toString('hex');
await writeFile(path.join(cwd, 'fixture.txt'), `alpha ${nonce}\n`);
try {
  const child = spawn(
    process.execPath,
    [
      launcher,
      '--',
      '-p',
      `Delegate to the ${worker} agent type with model ${workerModel}: read fixture.txt, then use Edit to replace alpha with beta while preserving the remaining text. Have the worker report the exact resulting line. Wait for completion. Do not read or edit the file yourself.`,
      '--model',
      parent,
      '--effort',
      'low',
      '--system-prompt',
      'You coordinate a small native subagent integration test. Use the requested worker and report its result.',
      ...(cursor
        ? ['--permission-mode', 'auto', '--allowedTools', 'Agent']
        : ['--tools', 'Agent,Read,Edit', '--allowedTools', 'Agent,Read,Edit']),
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--output-format',
      'stream-json',
      '--verbose',
    ],
    {
      cwd,
      detached: true,
      env: isolatedEnvironment({
        MULTI_NATIVE_TRACE: '1',
        CLAUDE_CODE_MAX_RETRIES: '0',
        CLAUDE_CODE_MAX_TURNS: '8',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let diagnostics = '';
  assert(child.stdout && child.stderr, 'Piped child streams');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    diagnostics += chunk;
    process.stderr.write(chunk);
  });
  const timer = setTimeout(() => {
    try {
      if (child.pid) {
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch {}
  }, 120000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timer);
  const events: ClaudeEvent[] = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const results = events
    .filter((e) => e.type === 'result')
    .map((e) => ({
      result: e.result,
      is_error: e.is_error,
      subagent_stats: e.subagent_stats,
      permission_denials: e.permission_denials,
    }));
  const content = await readFile(path.join(cwd, 'fixture.txt'), 'utf8');
  console.log(
    JSON.stringify(
      {
        code,
        results,
        fileCorrect: content === `beta ${nonce}\n`,
        auth: events.find((e) => e.type === 'system' && e.subtype === 'init')?.apiKeySource,
      },
      null,
      2,
    ),
  );
  assert.equal(code, 0);
  assert.equal(content, `beta ${nonce}\n`);
  assert(results.some((e) => !e.is_error && e.result?.includes(nonce)));
  assert(
    diagnostics.includes(
      parent.startsWith('multi/openai/')
        ? '"route":"openai-request"'
        : '"route":"anthropic","status":200',
    ),
  );
  const { model, effort } = cursor
    ? { model: cursor.model, effort: undefined }
    : { model: workerModel, effort: OPENAI_WORKER_EFFORT };
  const routeModel = cursor ? model : `multi/openai/${model}`;
  assert(diagnostics.includes(`"model":"${routeModel}"`));
  const requests: TraceEvent[] = diagnostics
    .split('\n')
    .filter((line) => line.startsWith('[native] '))
    .map((line) => JSON.parse(line.slice('[native] '.length)))
    .filter((event: TraceEvent) => event.route === (cursor ? 'cursor' : 'openai-request'));
  assert(requests.length >= (cursor ? 2 : 3), 'Expected external dispatch and completion');
  assert(
    requests.every((request) => request.model === model && (cursor || request.effort === effort)),
    'Wrong upstream model or effort',
  );
  if (cursor) {
    assert(
      diagnostics.includes('"tools":[]'),
      'Cursor actions must not be emitted as Claude tools',
    );
  } else {
    assert(diagnostics.includes('"tools":["Read"]'));
    assert(diagnostics.includes('"tools":["Edit"]'));
  }
  console.log(
    `PASS: real ${parent} parent + ${worker} (${model}${effort ? `, ${effort}` : ''}) + native Read/Edit + completion.`,
  );
} finally {
  await removeTemporary(cwd);
}

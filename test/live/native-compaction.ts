// Opt-in live contract: real compaction boundaries, memory, tools, and disk resume.
// Uses subscriptions and synthetic data only. Each turn starts a fresh gateway/CLI.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';
import { MODELS, OPENAI_WORKER_EFFORT } from '../../plugins/multi-openai/src/models.ts';
import { isolatedEnvironment } from './environment.ts';

interface Event {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  permission_denials?: unknown[];
  compact_metadata?: { trigger?: string; pre_tokens?: number };
  message?: { model?: string; content?: string | { type: string; name?: string }[] };
}
interface Trace {
  route: string;
  model?: string;
  effort?: string;
  status?: number;
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: npm run test:live:compaction -- [gpt-6-luna] [--manual-only]\nRuns real manual/repeated/automatic compaction and disk resume using Claude and OpenAI subscriptions. Native Cursor compaction is not supported by this test.',
  );
  process.exit(0);
}
const manualOnly = args.includes('--manual-only');
const positional = args.filter((arg) => arg !== '--manual-only');
const worker = positional[0] ?? 'gpt-6-luna';
assert(positional.length <= 1, 'Expected one OpenAI model and optional --manual-only');
assert(
  Object.values(MODELS).includes(worker),
  'Expected an OpenAI model; native Cursor compaction is not supported by this test.',
);
const selection = { model: worker, effort: OPENAI_WORKER_EFFORT };
const target = {
  ...selection,
  route: 'openai-request',
  model: `multi/openai/${selection.model}`,
  traceModel: selection.model,
};
const model = target.model;
const launcher = fileURLToPath(
  new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
);
const artifacts = await mkdtemp(path.join(tmpdir(), 'native-compaction-'));
const cwd = path.join(artifacts, 'workspace');
await mkdir(cwd);
const sessionId = randomUUID();
// Short, labelled markers test exact retention without making random hex copying the task.
const fileNonce = `file-${randomBytes(4).toString('hex')}`;
const decision = `release-${randomBytes(4).toString('hex')}`;
await writeFile(path.join(cwd, 'fixture.txt'), `alpha ${fileNonce}\n`);
const report = {
  version: 1,
  claudeVersion: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
  nodeVersion: process.version,
  worker,
  sessionId,
  automatic: !manualOnly,
  passed: false,
  stages: [] as {
    name: string;
    model: string;
    elapsedMs: number;
    boundaries: Event['compact_metadata'][];
    requests: Trace[];
  }[],
  error: undefined as string | undefined,
};
let attempted = 0;
let currentStage = '';
console.log(`Compaction test: ${worker}; artifacts: ${artifacts}`);

async function turn(
  name: string,
  prompt: string,
  selectedModel = model,
  tools = '',
  automatic = false,
) {
  currentStage = name;
  const first = attempted++ === 0;
  const started = Date.now();
  console.log(`RUN ${name} (${selectedModel})`);
  const env = isolatedEnvironment({
    MULTI_NATIVE_TRACE: '1',
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_MAX_TURNS: '8',
  });
  // Isolate inherited compaction switches. The automatic case uses a real 50K
  // trigger (50% of a 100K window), never forged provider usage or a fake summary.
  for (const key of [
    'DISABLE_COMPACT',
    'DISABLE_AUTO_COMPACT',
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  ]) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  if (automatic) {
    (env as NodeJS.ProcessEnv).CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50';
  }
  const child = spawn(
    process.execPath,
    [
      launcher,
      '--',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(first ? ['--session-id', sessionId] : ['--resume', sessionId]),
      '--model',
      selectedModel,
      ...(target.effort ? ['--effort', target.effort] : []),
      '--tools',
      tools,
      '--allowedTools',
      tools,
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--debug-file',
      path.join(artifacts, `${name}.debug.log`),
      ...(automatic ? ['--autocompact', '100k'] : []),
    ],
    { cwd, detached: process.platform !== 'win32', env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  let diagnostics = '';
  let timedOut = false;
  const stop = () => {
    if (child.pid) {
      terminateProcessTree(child.pid, { platform: process.platform, signal: 'SIGKILL' });
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, 240000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.length > 8 * 1024 * 1024) {
      stop();
    }
  });
  child.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-1024 * 1024);
  });
  child.stdin.on('error', () => {}); // Early CLI exit is reported below with its diagnostics.
  child.stdin.end(prompt);
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  await writeFile(path.join(artifacts, `${name}.jsonl`), output);
  await writeFile(path.join(artifacts, `${name}.stderr`), diagnostics);
  assert(!timedOut, `${name}: timed out after four minutes`);
  assert.equal(code, 0, `${name}: CLI exit ${code}; ${diagnostics.slice(-1500)}`);
  const events: Event[] = output
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const result = events.findLast((event) => event.type === 'result');
  assert(result && !result.is_error, `${name}: ${result?.result ?? 'No result event'}`);
  assert.equal(result.session_id, sessionId, `${name}: did not resume the requested session`);
  assert.equal(result.permission_denials?.length ?? 0, 0, `${name}: unexpected permission denial`);
  const requests: Trace[] = diagnostics
    .split('\n')
    .filter((line) => line.startsWith('[native] '))
    .map((line) => JSON.parse(line.slice(9)))
    .filter((event: Trace) => ['openai-request', 'anthropic'].includes(event.route));
  const boundaries = events
    .filter((event) => event.type === 'system' && event.subtype === 'compact_boundary')
    .map((event) => event.compact_metadata);
  report.stages.push({
    name,
    model: selectedModel,
    elapsedMs: Date.now() - started,
    boundaries,
    requests,
  });
  if (prompt.startsWith('/compact')) {
    assert(boundaries.length, `${name}: compaction did not run: ${result.result}`);
  }
  if (selectedModel === model) {
    assert(
      requests.some((event) => event.route === target.route && event.model === target.traceModel),
      `${name}: no request reached the selected provider model`,
    );
    assert(
      requests
        .filter((event) => event.route === target.route)
        .every((event) => event.model === target.traceModel && event.effort === target.effort),
      `${name}: unexpected provider model/effort`,
    );
  } else {
    assert(
      requests.some((event) => event.route === 'anthropic' && event.status === 200),
      `${name}: no successful Claude request`,
    );
  }
  if (!tools) {
    assert(
      !events.some(
        (event) =>
          event.type === 'assistant' &&
          Array.isArray(event.message?.content) &&
          event.message.content.some((block) => block.type === 'tool_use'),
      ),
      `${name}: recall must not use tools`,
    );
  }
  return { text: result.result ?? '', boundaries, events };
}

function remembers(text: string) {
  assert(
    text.includes(fileNonce),
    `${currentStage}: lost original file nonce ${fileNonce}: ${text}`,
  );
  assert(
    text.includes(decision),
    `${currentStage}: lost conversation-only release code ${decision}: ${text}`,
  );
}
function compacted(boundaries: Event['compact_metadata'][], trigger: string) {
  assert.equal(
    boundaries.length,
    1,
    `${currentStage}: expected exactly one real compaction boundary`,
  );
  const boundary = boundaries[0];
  assert(boundary);
  const tokens = boundary.pre_tokens;
  assert.equal(boundary.trigger, trigger);
  assert(
    typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens > 0,
    'Missing pre-compaction token count',
  );
  console.log(`PASS ${currentStage}: ${trigger} boundary at ${tokens} tokens`);
}
const recall =
  'Without tools, report the original file nonce, the release code from our earlier conversation, and the current prefix in fixture.txt. Do not guess.';
const compact =
  '/compact Preserve the exact original file nonce, the conversation-only release code, the current file contents, and completed edits. Summarize disposable padding briefly; do not retain its lines.';
try {
  remembers(
    (
      await turn(
        '01-seed',
        `Read fixture.txt and report its exact contents. Our release code is ${decision}. Keep both identifiers in conversation memory for later work and report both now. Never write the release code to a file.`,
        'sonnet',
        'Read',
      )
    ).text,
  );
  const edited = await turn(
    '02-edit',
    'Read fixture.txt, then use Edit to replace alpha with beta while preserving the nonce and newline. Report both remembered identifiers.',
    model,
    'Read,Edit',
  );
  remembers(edited.text);
  assert(
    edited.events.some(
      (event) =>
        Array.isArray(event.message?.content) &&
        event.message.content.some((block) => block.type === 'tool_use' && block.name === 'Edit'),
    ),
    'Expected a native Edit',
  );
  assert.equal(await readFile(path.join(cwd, 'fixture.txt'), 'utf8'), `beta ${fileNonce}\n`);
  compacted((await turn('03-manual', compact)).boundaries, 'manual');
  const recalled = await turn('04-resume-recall', recall);
  remembers(recalled.text);
  assert(recalled.text.includes('beta'));
  await turn(
    '05-post-compact-edit',
    'Read fixture.txt and use Edit to replace beta with gamma while preserving the rest. Report completion.',
    model,
    'Read,Edit',
  );
  assert.equal(await readFile(path.join(cwd, 'fixture.txt'), 'utf8'), `gamma ${fileNonce}\n`);
  compacted((await turn('06-repeat-manual', compact)).boundaries, 'manual');
  remembers((await turn('07-repeat-recall', recall)).text);
  if (!manualOnly) {
    // ponytail: one bounded synthetic history exercises the auto trigger; this is not a full-window stress benchmark.
    const padding = Array.from(
      { length: 3500 },
      (_, i) => `Disposable row ${i}: ${randomBytes(10).toString('hex')}`,
    ).join('\n');
    await turn(
      '08-padding',
      `The following is disposable test padding. Acknowledge receipt in one sentence; preserve our earlier identifiers and file state, but do not repeat or retain individual rows.\n${padding}`,
    );
    const automatic = await turn('09-automatic', recall, model, '', true);
    compacted(automatic.boundaries, 'auto');
    remembers(automatic.text);
    assert(automatic.text.includes('gamma'));
  }
  const back = await turn('10-return-to-claude', recall, 'sonnet');
  remembers(back.text);
  assert(back.text.includes('gamma'));
  report.passed = true;
  console.log(
    `PASS: manual/repeated${manualOnly ? '' : '/automatic'} compaction, fresh-process resume, native editing, and return to Claude.`,
  );
} catch (error) {
  report.error = `${currentStage}: ${error instanceof Error ? error.message : String(error)}`;
  throw error;
} finally {
  await writeFile(path.join(artifacts, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${path.join(artifacts, 'report.json')}`);
}

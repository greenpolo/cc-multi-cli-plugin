// Opt-in live contract for GPT through the Codex CLI's app-server. The default run uses
// three small paid turns on one Codex thread: a native write, a resumed read, and a Plan
// turn that must stay read-only, plus a free replay proving a saved answer does not
// repeat the write. Reports each turn's tokens, cached share included.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MessagesRequest,
  MessagesResponse,
} from '../../plugins/multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import {
  type CodexRunOptions,
  type CodexStreamEvent,
  runCodexTurn,
} from '../../plugins/multi-openai/src/app-server.ts';
import { CodexHarness } from '../../plugins/multi-openai/src/harness.ts';
import { discoverCodex } from '../../plugins/multi-openai/src/models.ts';
import { codexPermissionPolicy } from '../../plugins/multi-openai/src/permissions.ts';
import { readCodexUsage } from '../../plugins/multi-openai/src/usage.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node test/live/native-codex.ts [--model ID] [--effort EFFORT] [--task [PROMPT]]\nDefault: three small turns on gpt-6-luna plus a free replay. --task instead runs one substantial task (and a short follow-up on the same thread) in a copy of this checkout, reporting tokens, cache share and quota before and after. Requires codex login.',
  );
  process.exit(0);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const { signedIn, models } = await discoverCodex();
assert(signedIn, 'Codex is not signed in. Run codex login first.');
const requested = option('--model') ?? 'gpt-6-luna';
const model = models.find((candidate) => candidate.id === requested);
assert(model, `Codex does not list ${requested}`);
const effort = option('--effort') ?? 'low';
const taskMode = args.includes('--task');
const taskArgument = option('--task');
const TASK =
  taskArgument && !taskArgument.startsWith('--')
    ? taskArgument
    : 'Read every file under plugins/multi-grok/src and plugins/multi-core/src/gateway/harness-cli.ts. ' +
      'Then write docs/grok-internals.md (about 800 words) explaining how a Grok turn runs from the ' +
      'gateway to the CLI and back: sessions, permissions, progress rows, failures. Cite file paths ' +
      'and function names. Finally check that every function name you cited exists, and fix any that do not.';

const root = await mkdtemp(path.join(os.tmpdir(), 'native-codex-'));
const cwd = path.join(root, 'workspace');
const stateDirectory = path.join(root, 'state');
if (taskMode) {
  // A real codebase to work in, without touching this checkout.
  await cp(process.cwd(), cwd, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(source),
  });
} else {
  await mkdir(cwd);
}
const target = 'native-write-once.txt';
const planTarget = 'plan-must-not-exist.txt';
const nonce = randomBytes(8).toString('hex');
const scope = `live/${randomUUID()}`;
const runs: { resume?: string; sandbox: string; thread?: string }[] = [];
const items: string[] = [];

function text(response: MessagesResponse): string {
  return response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

const run = async (options: CodexRunOptions) => {
  const record: (typeof runs)[number] = { resume: options.resume, sandbox: options.sandbox };
  runs.push(record);
  const onEvent = (event: CodexStreamEvent) => {
    if (event.event === 'thread') {
      record.thread = event.threadId;
    }
    if (event.event === 'item' && event.phase === 'completed') {
      items.push(event.item.type);
    }
    options.onEvent?.(event);
  };
  return runCodexTurn({ ...options, onEvent });
};

const harness = new CodexHarness(models, {
  cwd,
  stateDirectory,
  run,
  checkPermissions: async (runCwd, runContext) =>
    codexPermissionPolicy({ ...runContext, cwd: runCwd }),
});

async function turn(
  messages: NonNullable<MessagesRequest['messages']>,
  context: PermissionContext,
): Promise<MessagesResponse> {
  const response = await harness.handle(
    { model: model?.model, messages, output_config: { effort } } as MessagesRequest,
    scope,
    AbortSignal.timeout(240000),
    undefined,
    context,
  );
  console.log(
    JSON.stringify({ response: text(response).slice(0, 300), usage: response.usage }, null, 1),
  );
  return response;
}

const bypass: PermissionContext = { permissionMode: 'bypassPermissions', cwd };
const plan: PermissionContext = { permissionMode: 'plan', cwd };

async function substantialTask() {
  const quota = async () => (await readCodexUsage().catch(() => undefined))?.windows;
  const before = await quota();
  const started = Date.now();
  const first = await turn([{ role: 'user', content: TASK }], bypass);
  const firstSeconds = Math.round((Date.now() - started) / 1000);
  const follow = await turn(
    [
      { role: 'user', content: TASK },
      { role: 'assistant', content: first.content },
      { role: 'user', content: 'In three lines: what did you write, and what did you fix?' },
    ],
    bypass,
  );
  assert.equal(runs[1]?.resume, runs[0]?.thread, 'The follow-up must resume the Codex thread');
  const after = await quota();
  const share = (usage: MessagesResponse['usage']) => {
    const cached = usage.cache_read_input_tokens ?? 0;
    const total = usage.input_tokens + cached;
    return total ? `${Math.round((cached / total) * 100)}%` : 'n/a';
  };
  console.log(
    JSON.stringify(
      {
        ok: true,
        model: model?.id,
        effort,
        task: { seconds: firstSeconds, usage: first.usage, cachedShare: share(first.usage) },
        followUp: { usage: follow.usage, cachedShare: share(follow.usage) },
        items: Object.fromEntries(
          [...new Set(items)].map((type) => [type, items.filter((item) => item === type).length]),
        ),
        quotaBefore: before,
        quotaAfter: after,
      },
      null,
      1,
    ),
  );
}

try {
  if (taskMode) {
    await substantialTask();
  } else {
    await contract();
  }
} finally {
  await harness.close();
}

async function contract() {
  const before = await readCodexUsage().catch(() => undefined);
  const writePrompt = `Create the file ${target} in this workspace containing exactly ${nonce}. Write it once, then stop.`;
  const first = await turn([{ role: 'user', content: writePrompt }], bypass);
  assert(runs[0].thread && !runs[0].resume, 'The first turn must start its own Codex thread');
  const written = await readFile(path.join(cwd, target), 'utf8');
  assert.match(written, new RegExp(nonce), 'The Codex write did not reach the workspace');

  const replay = await turn([{ role: 'user', content: writePrompt }], bypass);
  assert.equal(runs.length, 1, 'An identical completed request must not run Codex again');
  assert.equal(replay.multi_usage?.replayed, true, 'The replayed response must be marked');

  const history = [
    { role: 'user' as const, content: writePrompt },
    { role: 'assistant' as const, content: first.content },
  ];
  const read = await turn(
    [...history, { role: 'user', content: `Report the exact contents of ${target} only.` }],
    bypass,
  );
  assert.equal(runs[1].resume, runs[0].thread, 'The follow-up must resume the Codex thread');
  assert.match(text(read), new RegExp(nonce), 'The resumed thread lost its own record');

  await turn(
    [
      ...history,
      { role: 'assistant', content: read.content },
      {
        role: 'user',
        content: `Create the file ${planTarget} containing ${nonce}. If you cannot write, say exactly READ ONLY.`,
      },
    ],
    plan,
  );
  assert.equal(runs[2].sandbox, 'read-only', 'Plan must run Codex read-only');
  await assert.rejects(stat(path.join(cwd, planTarget)), 'Plan let Codex write a file');

  const after = await readCodexUsage().catch(() => undefined);
  console.log(
    JSON.stringify({
      ok: true,
      model: model?.id,
      effort,
      turns: runs.length,
      items: [...new Set(items)],
      quotaBefore: before?.windows,
      quotaAfter: after?.windows,
    }),
  );
}

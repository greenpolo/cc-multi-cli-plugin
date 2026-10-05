// Two bounded SDK turns, or one read-only turn with --plan. Never use Fast.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, type AgentOptions, Cursor } from '@cursor/sdk';
import type { MessagesRequest } from '../../plugins/multi-core/src/gateway/messages.ts';
import {
  type PermissionContext,
  PermissionModes,
} from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { CursorHarness } from '../../plugins/multi-cursor/src/harness.ts';
import { cursorModelOptions } from '../../plugins/multi-cursor/src/models.ts';
import { removeTemporary } from '../temporary.ts';

const plan = process.argv.includes('--plan');
const compact = process.argv.includes('--compact');
const recover = process.argv.includes('--recover');
assert(!(plan && recover), '--recover requires the ordinary native edit run');
const modelId = process.argv.find((arg) => arg.startsWith('--model='))?.slice(8) ?? 'composer-2.5';
const models = cursorModelOptions(await Cursor.models.list());
const model = models.find(
  (option) => option.selection.id === modelId && option.model.split('/').length === 3,
);
assert(model, `${modelId} must be available for this bounded check`);
assert.equal(
  model.selection.params?.find((parameter) => parameter.id === 'fast')?.value,
  'false',
  'Never spend Fast usage in this test',
);
const cwd = await mkdtemp(path.join(os.tmpdir(), 'cursor-native-harness-'));
let completedRunId: string | undefined;
let recoveryLookups = 0;
let recovering = false;
const config = {
  cwd,
  stateDirectory: path.join(cwd, 'state'),
  ...(recover
    ? {
        createAgent: async (options: AgentOptions) => {
          const agent = await Agent.create(options);
          return {
            agentId: agent.agentId,
            close: () => agent.close(),
            send: async (...args: Parameters<typeof agent.send>) => {
              assert.equal(completedRunId, undefined, 'Recovery must not dispatch another SDK run');
              const run = await agent.send(...args);
              completedRunId = run.id;
              return run;
            },
          };
        },
        resumeAgent: async (id: string, options: AgentOptions) => {
          const agent = await Agent.resume(id, options);
          return {
            agentId: agent.agentId,
            close: () => agent.close(),
            send: (...args: Parameters<typeof agent.send>) => {
              assert(!recovering, 'Recovery must not dispatch another SDK run');
              return agent.send(...args);
            },
          };
        },
        getRun: async (id: string, runCwd: string) => {
          recoveryLookups++;
          assert.equal(id, completedRunId);
          return Agent.getRun(id, { cwd: runCwd, runtime: 'local' });
        },
      }
    : {}),
};
const secret = randomBytes(6).toString('hex');
await writeFile(path.join(cwd, 'fixture.txt'), `alpha ${secret}\n`);
const request: MessagesRequest = {
  model: model.model,
  messages: [
    {
      role: 'user',
      content: plan
        ? 'Read fixture.txt and report its full line. Only if editing tools are available, change alpha to beta first. Do nothing else.'
        : 'Read fixture.txt, change alpha to beta using your native edit tool, then report the full resulting line. Do nothing else.',
    },
  ],
};
let harness = new CursorHarness([model], config);
try {
  const mode: PermissionContext = { permissionMode: plan ? 'plan' : 'auto' };
  let first = await harness.handle(
    request,
    'live/main',
    AbortSignal.timeout(120000),
    undefined,
    mode,
  );
  assert(first.content.every((block) => block.type === 'text'));
  const expected = `${plan ? 'alpha' : 'beta'} ${secret}`;
  assert.equal(await readFile(path.join(cwd, 'fixture.txt'), 'utf8'), `${expected}\n`);
  assert.match(JSON.stringify(first.content), /\[Cursor\]/);
  assert(JSON.stringify(first.content).includes(expected));
  if (plan) {
    console.log(
      'PASS: Plan native read, unchanged fixture, and display-only output. One non-Fast inference turn.',
    );
  } else {
    await harness.close();
    if (recover) {
      assert(completedRunId);
      await emulateInterruptedCommit(config.stateDirectory, completedRunId);
      recovering = true;
    }
    harness = new CursorHarness([model], config);
    if (recover) {
      first = await harness.handle(
        request,
        'live/main',
        AbortSignal.timeout(15000),
        undefined,
        mode,
      );
      assert.equal(
        recoveryLookups,
        1,
        'Retry must read the actual SDK run instead of a cached reply',
      );
      assert(JSON.stringify(first.content).includes(expected));
      assert.equal(await readFile(path.join(cwd, 'fixture.txt'), 'utf8'), `${expected}\n`);
      console.log(
        'PASS: actual SDK getRun recovery after an interrupted gateway commit, without inference.',
      );
    }
    // A replay serves the saved response without inference, marked so the receipt ledger
    // never bills the same turn twice.
    assert.deepEqual(
      await harness.handle(request, 'live/main', AbortSignal.timeout(5000), undefined, mode),
      {
        ...first,
        multi_usage: first.multi_usage
          ? { ...first.multi_usage, replayed: true }
          : { source: 'unavailable', replayed: true },
      },
    );
    recovering = false;
    const followup = 'Without using tools, repeat the full line you just produced. One line only.';
    const hooks = new PermissionModes(async () => ({}));
    hooks.recordModSession('live', { permissionMode: 'auto' });
    const history = compact
      ? []
      : [...(request.messages ?? []), { role: 'assistant', content: first.content }];
    const second = await harness.handle(
      {
        ...request,
        messages: [
          ...history,
          {
            role: 'user',
            content: followup,
          },
        ],
      },
      'live/main',
      AbortSignal.timeout(120000),
      undefined,
      hooks.resolve('live'),
    );
    assert(JSON.stringify(second.content).includes(`beta ${secret}`));
    assert.equal(await readFile(path.join(cwd, 'fixture.txt'), 'utf8'), `beta ${secret}\n`);
    if (compact) {
      console.log(
        'PASS: fresh hook-confirmed prompt after outer history compaction retains native recall.',
      );
    }
    console.log(
      'PASS: native tools, display-only progress, persisted SDK resume, cached retry, and follow-up recall. Two non-Fast inference turns.',
    );
  }
} finally {
  await harness.close();
  // The SDK child can still hold the directory open on Windows for a moment.
  await removeTemporary(cwd);
}

async function emulateInterruptedCommit(directory: string, runId: string) {
  const files = await readdir(directory);
  const manifests = files.filter((file) => file.endsWith('.session.json'));
  assert.equal(manifests.length, 1);
  const manifest = manifests[0];
  assert(manifest);
  const file = path.join(directory, manifest);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.interrupted, false);
  assert.equal(typeof saved.replay?.key, 'string');
  assert.equal(typeof saved.response?.usage?.input_tokens, 'number');
  const pendingRun = {
    runId,
    key: saved.replay.key,
    model: saved.response.model,
    inputTokens: saved.response.usage.input_tokens,
  };
  // Remove both reply sources so only Agent.getRun can recover the first turn.
  for (const archive of files.filter((name) => name.endsWith('.response.json'))) {
    await rm(path.join(directory, archive));
  }
  await writeFile(
    file,
    JSON.stringify({
      ...saved,
      response: undefined,
      replay: undefined,
      interrupted: true,
      pendingRun,
    }),
  );
}

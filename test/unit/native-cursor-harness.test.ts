import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers';
import type { AgentOptions, Run, RunResult, SDKUserMessage, SendOptions } from '@cursor/sdk';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
} from '../../plugins/multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { lockStateFile } from '../../plugins/multi-core/src/gateway/state-lock.ts';
import { CursorProviderError } from '../../plugins/multi-cursor/src/errors.ts';
import {
  type CreateCursorHarnessAgent,
  CursorHarness,
} from '../../plugins/multi-cursor/src/harness.ts';
import { cursorModelOptions } from '../../plugins/multi-cursor/src/models.ts';
import { removeTemporary } from '../temporary.ts';

const models = cursorModelOptions([
  { id: 'test-model', displayName: 'Test Model' },
  { id: 'other-model', displayName: 'Other Model' },
]);
const body: MessagesRequest = {
  model: models[0].model,
  messages: [{ role: 'user', content: 'first request' }],
};
const signal = () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  timer.unref();
  return controller.signal;
};
// Polls sleep instead of spinning: a tight readFile loop keeps a handle open,
// which on Windows makes the harness's atomic rename fail. Every poll is bounded
// so a wrong expectation fails with a message instead of hitting the test timeout.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function until(condition: () => Promise<boolean> | boolean, what: string) {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await tick();
  }
}

function follow(response: MessagesResponse): MessagesRequest {
  return {
    ...body,
    messages: [
      ...(body.messages ?? []),
      { role: 'assistant', content: response.content },
      { role: 'user', content: 'second request' },
    ],
  };
}

function replayedResponse(response: MessagesResponse): MessagesResponse {
  return {
    ...response,
    multi_usage: response.multi_usage
      ? { ...response.multi_usage, replayed: true }
      : { source: 'unavailable', replayed: true },
  };
}

// These offline fixtures explicitly exercise Auto unless a test supplies another mode.
class AutoTestHarness extends CursorHarness {
  override handle(
    body: MessagesRequest,
    scope: string,
    signal: AbortSignal,
    emit?: Emit,
    context: PermissionContext = { permissionMode: 'auto' },
  ) {
    return super.handle(body, scope, signal, emit, context);
  }
}

async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cursor-harness-test-')));
  const configurations: AgentOptions[] = [];
  const sends: { id: string; prompt: string | SDKUserMessage; options?: SendOptions }[] = [];
  const resumed: string[] = [];
  const resumeConfigurations: AgentOptions[] = [];
  const results: ReturnType<typeof Promise.withResolvers<RunResult>>[] = [];
  const started = Promise.withResolvers<void>();
  let hold = false;
  let cancellations = 0;
  let closes = 0;
  let createGate: Promise<void> | undefined;
  let sendGate: Promise<void> | undefined;
  let cancelHangs = false;
  let cancelThrows = false;
  let resumeFails = false;
  let recovery: { result: RunResult; status: Run['status']; agentId: string } | undefined;
  const recoveryReads: string[] = [];
  function agent(id: string) {
    return {
      agentId: id,
      close() {
        closes++;
      },
      async getUsage() {
        return {
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            cacheReadTokens: 80,
            cacheWriteTokens: 10,
            totalTokens: 240,
            reasoningTokens: 12,
          },
          runs: [
            {
              runId: 'turn-1',
              usage: {
                inputTokens: 120,
                outputTokens: 30,
                cacheReadTokens: 80,
                cacheWriteTokens: 10,
                totalTokens: 240,
                reasoningTokens: 12,
              },
            },
          ],
        };
      },
      async send(prompt: string | SDKUserMessage, options?: SendOptions): Promise<Run> {
        sends.push({ id, prompt, options });
        started.resolve();
        const result = Promise.withResolvers<RunResult>();
        results.push(result);
        await options?.onDelta?.({ update: { type: 'summary-started' } });
        await options?.onDelta?.({ update: { type: 'text-delta', text: 'done' } });
        if (!hold) {
          result.resolve({ id: 'run', status: 'finished', result: 'done' });
        }
        await sendGate;
        return {
          id: 'run',
          agentId: id,
          status: 'running',
          wait: () => result.promise,
          cancel: () => {
            cancellations++;
            if (cancelThrows) {
              throw new Error('SDK cancellation threw');
            }
            return finishCancel(result);
          },
          async *stream() {},
          conversation: async () => [],
          supports: () => true,
          unsupportedReason: () => undefined,
          onDidChangeStatus: () => () => {},
        };
      },
    };
  }
  async function finishCancel(result: ReturnType<typeof Promise.withResolvers<RunResult>>) {
    if (cancelHangs) {
      await new Promise<void>(() => {});
    }
    result.resolve({ id: 'run', status: 'cancelled' });
  }
  const createAgent: CreateCursorHarnessAgent = async (config) => {
    configurations.push(config);
    await createGate;
    return agent(`agent-${configurations.length}`);
  };
  const config = {
    cwd: directory,
    stateDirectory: path.join(directory, 'state'),
    createAgent,
    getRun: async (id: string, cwd: string): Promise<Run> => {
      assert.equal(cwd, directory);
      recoveryReads.push(id);
      const saved = recovery;
      if (!saved) {
        throw new Error('No terminal SDK result');
      }
      return {
        id,
        agentId: saved.agentId,
        status: saved.status,
        wait: async () => saved.result,
        cancel: async () => {},
        async *stream() {},
        conversation: async () => [],
        supports: () => true,
        unsupportedReason: () => undefined,
        onDidChangeStatus: () => () => {},
      };
    },
    resumeAgent: async (id: string, config: AgentOptions) => {
      resumed.push(id);
      resumeConfigurations.push(config);
      if (resumeFails) {
        resumeFails = false;
        throw new Error('SDK resume failed');
      }
      return agent(id);
    },
  };
  const harnesses: CursorHarness[] = [];
  const make = () => {
    const harness = new AutoTestHarness(models, config);
    harnesses.push(harness);
    return harness;
  };
  t.after(async () => {
    await Promise.all(harnesses.map((harness) => harness.close()));
    await removeTemporary(directory);
  });
  return {
    make,
    started: started.promise,
    configurations,
    sends,
    resumed,
    resumeConfigurations,
    recoveryReads,
    recover: (result: RunResult, status: Run['status'] = result.status, agentId = 'agent-1') => {
      recovery = { result, status, agentId };
    },
    failNextResume: () => {
      resumeFails = true;
    },
    directory,
    sessionFile: path.join(
      directory,
      'state',
      `${createHash('sha256')
        .update(JSON.stringify(JSON.stringify([directory, 'main'])))
        .digest('hex')}.session.json`,
    ),
    results,
    hold: () => {
      hold = true;
    },
    cancellations: () => cancellations,
    closes: () => closes,
    delayCreate: (promise: Promise<void>) => {
      createGate = promise;
    },
    delaySend: (promise: Promise<void>) => {
      sendGate = promise;
    },
    throwCancel: () => {
      cancelThrows = true;
    },
    hangCancel: () => {
      cancelHangs = true;
    },
  };
}

test('Cursor billed usage is queried separately from turn accounting', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  await harness.handle(body, 'billing', signal());
  const billed = await harness.billedUsage('billing');
  assert.equal(billed[0].agentId, 'agent-1');
  assert.equal(billed[0].scope, 'billing');
  assert.equal(billed[0].usage.totalTokens, 240);
  assert.equal(billed[0].runs[0].runId, 'turn-1');
});

test('Cursor maps native run totals once and preserves them through disk replay', async (t) => {
  const f = await fixture(t);
  f.hold();
  const harness = f.make();
  const pending = harness.handle(body, 'main', signal());
  await f.started;
  f.results[0].resolve({
    id: 'run',
    status: 'finished',
    result: 'done',
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      totalTokens: 240,
      reasoningTokens: 12,
    },
  });
  const result = await pending;
  assert.deepEqual(result.usage, {
    input_tokens: 120,
    output_tokens: 30,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 10,
  });
  assert.equal(result.multi_usage?.source, 'provider');
  assert.equal(result.multi_usage?.total_tokens, 240);
  assert.equal(result.multi_usage?.reasoning_tokens, 12);
  await harness.close();
  const replay = await f.make().handle(body, 'main', signal());
  assert.deepEqual(replay.usage, result.usage);
  assert.equal(replay.multi_usage?.replayed, true);
  assert.equal(f.sends.length, 1);
});

test('Cursor billed session queries match exact session identity across worker scopes', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  for (const scope of [
    ['s', 'main'],
    ['s', 'worker'],
    ['s-other', 'main'],
  ]) {
    await harness.handle(body, JSON.stringify(scope), signal());
  }
  const billed = await harness.billedUsageForSession('s');
  assert.equal(billed.length, 2);
  assert(billed.every((entry) => JSON.parse(entry.scope)[0] === 's'));
  assert.deepEqual(await harness.billedUsageForSession('missing'), []);
});

async function interruptedManifest(f: Awaited<ReturnType<typeof fixture>>) {
  const harness = f.make();
  await harness.handle(body, 'main', signal());
  await harness.close();
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  await writeFile(
    f.sessionFile,
    JSON.stringify({
      ...saved,
      response: undefined,
      replay: undefined,
      interrupted: true,
      pendingRun: {
        key: saved.replay.key,
        runId: 'run',
        inputTokens: saved.response.usage.input_tokens,
        model: body.model,
      },
    }),
  );
}

/** No `f.hold()`: the SDK mock auto-finishes, so this dispatches and returns in one step. */
async function expectInterruptedRetry(f: Awaited<ReturnType<typeof fixture>>) {
  const harness = f.make();
  const index = f.sends.length;
  const response = await harness.handle(body, 'main', signal());
  assert.match(JSON.stringify(f.sends[index].prompt), /previous turn was interrupted/);
  assert.match(JSON.stringify(response.content), /previous turn was interrupted/);
  return { harness, response };
}

test('native Cursor retains an agent, sends only new history, and renders progress without executable tools', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal());
  assert(response.content.every((block) => block.type === 'text'));
  assert.match(JSON.stringify(response.content), /Compacting context/);
  const next = await harness.handle(follow(response), 'main', signal(), undefined, {
    permissionMode: 'plan',
  });
  assert.equal(next.stop_reason, 'end_turn');
  assert.equal(f.configurations.length, 1);
  assert.equal(f.sends[1].options?.mode, 'plan');
  assert.deepEqual(f.resumed, [f.sends[0].id]);
  assert.deepEqual(f.resumeConfigurations[0].tools, ['read', 'grep', 'glob', 'ls']);
  assert.match(JSON.stringify(f.sends[1].prompt), /second request/);
  assert.doesNotMatch(JSON.stringify(f.sends[1].prompt), /first request|Compacting context/);
  assert.equal(f.configurations[0].local?.autoReview, true);
  assert.equal(f.configurations[0].local?.customTools, undefined);
  await harness.handle(body, 'worker', signal());
  assert.equal(f.configurations.length, 2);
  assert.notEqual(f.sends[0].id, f.sends[2].id);
});

test('changed worker policy resumes native state and a failed resume never sends under the old policy', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal(), undefined, {
    permissionMode: 'auto',
    tools: ['Read'],
  });
  assert.deepEqual(f.configurations[0].tools, ['read', 'ls']);
  f.failNextResume();
  const next = follow(response);
  const context = { permissionMode: 'auto' as const, tools: ['Grep'] };
  await assert.rejects(harness.handle(next, 'main', signal(), undefined, context), /resume failed/);
  assert.equal(f.sends.length, 1);
  await harness.handle(next, 'main', signal(), undefined, context);
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].id, f.sends[0].id);
  assert.deepEqual(
    f.resumeConfigurations.map((config) => config.tools),
    [['grep'], ['grep']],
  );
  assert.equal(f.closes(), 1, 'the old SDK instance is closed once despite retry');
  assert.doesNotMatch(JSON.stringify(f.sends[1].prompt), /first request/);
});

test('returning to Auto after failed Plan resume replaces the closed SDK handle', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal());
  const next = follow(response);
  f.failNextResume();
  await assert.rejects(
    harness.handle(next, 'main', signal(), undefined, { permissionMode: 'plan' }),
    /resume failed/,
  );
  assert.equal(f.sends.length, 1);
  await harness.handle(next, 'main', signal());
  assert.equal(f.resumed.length, 2);
  assert.deepEqual(f.resumeConfigurations[1].tools, f.configurations[0].tools);
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].options?.mode, 'agent');
});

test('native Cursor changes model in one scope and resumes after another provider without replaying history', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const first = await harness.handle(body, 'main', signal());
  const switchedRequest = { ...follow(first), model: models[1].model };
  const switched = await harness.handle(switchedRequest, 'main', signal());
  assert.equal(f.configurations.length, 1);
  assert.equal(f.sends[0].id, f.sends[1].id);
  assert.deepEqual(f.sends[1].options?.model, models[1].selection);

  await harness.handle(
    {
      ...switchedRequest,
      messages: [
        ...(switchedRequest.messages ?? []),
        { role: 'assistant', content: switched.content },
        { role: 'user', content: 'Ask the other provider to inspect the result.' },
        { role: 'assistant', content: 'The other provider inspected the result.' },
        { role: 'user', content: 'Continue with Cursor using that result.' },
      ],
    },
    'main',
    signal(),
  );
  assert.equal(f.configurations.length, 1);
  assert.equal(f.sends[1].id, f.sends[2].id);
  const appended = JSON.stringify(f.sends[2].prompt);
  assert.match(appended, /Ask the other provider|Continue with Cursor/);
  assert.doesNotMatch(appended, /first request|second request/);
});

test('completed requests deduplicate across disk resume and follow-ups use the saved SDK agent', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  const response = await first.handle(body, 'main', signal());
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  assert.equal(saved.version, 3);
  assert(!('history' in saved));
  assert(!('historyLength' in saved));
  assert.doesNotMatch(JSON.stringify(saved), /first request/);
  await first.close();
  const second = f.make();
  assert.deepEqual(await second.handle(body, 'main', signal()), replayedResponse(response));
  assert.equal(f.sends.length, 1);
  await second.handle(follow(response), 'main', signal());
  assert.deepEqual(f.resumed, ['agent-1']);
  assert.equal(f.configurations.length, 1);
  assert.doesNotMatch(JSON.stringify(f.sends[1].prompt), /first request/);
});

test('one disconnected observer does not cancel a shared native run; all disconnected observers do', async (t) => {
  const f = await fixture(t);
  f.hold();
  const harness = f.make();
  const left = new AbortController();
  const right = new AbortController();
  const one = harness.handle(body, 'main', left.signal);
  const two = harness.handle(body, 'main', right.signal);
  await Promise.race([f.started, one]);
  left.abort(new Error('left disconnected'));
  await assert.rejects(one, /left disconnected/);
  assert.equal(f.cancellations(), 0);
  right.abort(new Error('right disconnected'));
  await assert.rejects(two, /right disconnected/);
  await tick();
  assert.equal(f.cancellations(), 1);
  await assert.rejects(harness.handle(body, 'main', signal()));
  assert.equal(f.sends.length, 1);
});

test('a prompt sent during a run is refused instead of resuming stale history', async (t) => {
  const f = await fixture(t);
  f.hold();
  const harness = f.make();
  const running = harness.handle(body, 'main', signal());
  await f.started;
  // The second prompt was composed before the running turn answered. Resuming
  // with it would forward that turn again, so it is refused deterministically
  // (400) rather than answered with a retryable failure.
  const refused = harness.handle(
    { ...body, messages: [{ role: 'user', content: 'sent while the first turn runs' }] },
    'main',
    signal(),
  );
  await assert.rejects(refused, (error: unknown) => {
    assert(error instanceof CursorProviderError);
    assert.equal(error.failure.status, 400);
    assert.match(error.message, /already running for this Cursor agent/);
    return true;
  });
  assert.equal(f.sends.length, 1, 'the refused prompt must not reach the SDK');
  f.results[0].resolve({ id: 'run', status: 'finished', result: 'done' });
  await running;
  assert.equal(f.sends.length, 1);
});

test('terminal cancellation is durable and a new observed prompt can continue in the same gateway', async (t) => {
  const f = await fixture(t);
  f.hold();
  const first = f.make();
  const abort = new AbortController();
  const request = first.handle(body, 'main', abort.signal);
  await Promise.race([f.started, request]);
  abort.abort(new Error('disconnect'));
  await assert.rejects(request);
  // The outer request settles as soon as the caller disconnects; the internal
  // cancellation and its durability write finish independently afterward.
  await until(() => f.cancellations() >= 1, 'the native cancellation');
  let saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  await until(async () => {
    saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
    return !saved.interrupted;
  }, 'the terminal cancellation to be persisted');
  // A genuine terminal result (even a cancelled one) resolves the uncertainty;
  // the session is not left interrupted.
  assert.equal(saved.interrupted, false);
  const next = first.handle(
    { ...body, messages: [{ role: 'user', content: 'new task' }] },
    'main',
    signal(),
  );
  await until(() => f.sends.length >= 2, 'the second native send');
  f.results[1].resolve({ id: 'run', status: 'finished', result: 'done' });
  await next;
  assert.doesNotMatch(JSON.stringify(f.sends[1].prompt), /first request/);
  assert.equal(f.cancellations(), 1);
});

test('a second gateway cannot take a live scope while its session file is locked', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  await harness.handle(body, 'main', signal());
  await assert.rejects(
    f
      .make()
      .handle(
        { ...body, messages: [{ role: 'user', content: 'another request' }] },
        'main',
        signal(),
      ),
    /locked/,
  );
  assert.equal(f.sends.length, 1);
});

test('continuation requires a message after the last assistant turn and a new user message', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal());
  await assert.rejects(
    harness.handle(
      {
        ...body,
        messages: [...(body.messages ?? []), { role: 'assistant', content: response.content }],
      },
      'main',
      signal(),
    ),
    /message after the last assistant turn/,
  );
  await assert.rejects(
    harness.handle(
      {
        ...body,
        messages: [
          ...(body.messages ?? []),
          { role: 'assistant', content: response.content },
          { role: 'system', content: 'a reminder with no new user turn' },
        ],
      },
      'main',
      signal(),
    ),
    /new user message/,
  );
});

test('outer history changes stream a rewind notice and continue on the native record', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal());
  const matching = await harness.handle(follow(response), 'main', signal());
  assert.doesNotMatch(JSON.stringify(matching.content), /Outer history changed/);
  const rewritten: MessagesRequest = {
    ...body,
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'a different remembered reply' }] },
      { role: 'user', content: 'New anchored task' },
    ],
  };
  const changed = await harness.handle(rewritten, 'main', signal());
  assert(changed.content[0].type === 'text');
  assert.match(changed.content[0].text, /Outer history changed; the native conversation continues/);
  assert.match(JSON.stringify(f.sends[2].prompt), /New anchored task/);
  assert.doesNotMatch(
    JSON.stringify(f.sends[2].prompt),
    /a different remembered reply|first request/,
  );
});

test('shutdown during delayed agent creation closes the late agent without sending', async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers<void>();
  f.delayCreate(gate.promise);
  const harness = f.make();
  const request = harness.handle(body, 'main', signal());
  void request.catch(() => {});
  await until(() => f.configurations.length > 0, 'the native configuration');
  await harness.close();
  gate.resolve();
  await assert.rejects(request, /closed|disconnected/);
  assert.equal(f.sends.length, 0);
  assert.equal(f.closes(), 1);
});

test('repeated session cleanup cannot remove a replacement gateway lock', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal());
  // biome-ignore lint/complexity/useLiteralKeys: test intentionally inspects private session state.
  const store = harness['store'];
  const session = [...store.sessions()].find((record) => record.identity.includes('"main"'));
  assert(session);
  await store.releaseLock(session);
  const release = await lockStateFile(`${f.sessionFile}.lock`);
  t.after(release);
  await harness.close();
  await assert.rejects(f.make().handle(follow(response), 'main', signal()), /locked/);
  assert.equal(f.sends.length, 1);
});

test('shutdown bounds hung cancellation and retains the interrupted session lock', async (t) => {
  const f = await fixture(t);
  f.hold();
  f.hangCancel();
  const harness = f.make();
  const request = harness.handle(body, 'main', signal());
  void request.catch(() => {});
  await Promise.race([f.started, request]);
  await tick();
  const before = Date.now();
  await harness.close();
  assert(Date.now() - before < 2500);
  assert.equal(f.cancellations(), 1);
  assert.equal(f.closes(), 1);
  await assert.rejects(
    f.make().handle({ ...body, system: 'different' }, 'main', signal()),
    /locked/,
  );
  f.results[0].resolve({ id: 'run', status: 'cancelled' });
  await assert.rejects(request);
  await tick();
  assert.equal(f.closes(), 1);
});

test('shutdown during delayed send cancels the eventual run and never reports success', async (t) => {
  const f = await fixture(t);
  f.hold();
  const gate = Promise.withResolvers<void>();
  f.delaySend(gate.promise);
  const harness = f.make();
  const request = harness.handle(body, 'main', signal());
  void request.catch(() => {});
  await Promise.race([f.started, request]);
  await harness.close();
  gate.resolve();
  await assert.rejects(request);
  assert.equal(f.cancellations(), 1);
});

test('failed atomic completion preserves uncertainty and a later retry resumes with an interrupted notice', async (t) => {
  const f = await fixture(t);
  f.hold();
  const harness = f.make();
  const events: string[] = [];
  const request = harness.handle(body, 'main', signal(), (name) => {
    events.push(name);
  });
  await Promise.race([f.started, request]);
  // The dispatch durability write lands shortly after the run starts. Swap the
  // file for a directory only once it has landed, or the write would race the
  // swap and recreate the file.
  await until(async () => {
    const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
    return saved.pendingRun?.runId === 'run';
  }, 'the dispatch durability write');
  const backup = `${f.sessionFile}.backup`;
  await rename(f.sessionFile, backup);
  await mkdir(f.sessionFile);
  f.results[0].resolve({ id: 'run', status: 'finished', result: 'done' });
  await assert.rejects(request);
  assert(!events.includes('message_stop'));
  assert(!events.includes('message_delta'));
  assert.equal(f.sends.length, 1);
  await rm(f.sessionFile, { recursive: true });
  await rename(backup, f.sessionFile);
  await harness.close();
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  assert.equal(saved.interrupted, true);
  // Without a recorded run id there is nothing to recover, so the retry must
  // resume with the interrupted notice. Recovery itself is covered separately.
  delete saved.pendingRun.runId;
  await writeFile(f.sessionFile, JSON.stringify(saved));
  const second = f.make();
  const retry = second.handle(body, 'main', signal());
  await until(() => f.sends.length >= 2, 'the second native send');
  assert.match(JSON.stringify(f.sends[1].prompt), /previous turn was interrupted/);
  f.results[1].resolve({ id: 'run', status: 'finished', result: 'done' });
  const response = await retry;
  assert.match(JSON.stringify(response.content), /previous turn was interrupted/);
  assert.equal(f.sends.length, 2);
});

test('synchronous SDK cancellation errors stay inside native run cleanup', async (t) => {
  const f = await fixture(t);
  f.hold();
  f.throwCancel();
  const harness = f.make();
  const observer = new AbortController();
  const request = harness.handle(body, 'main', observer.signal);
  await Promise.race([f.started, request]);
  await tick();
  observer.abort(new Error('observer disconnected'));
  await assert.rejects(request, /observer disconnected/);
  await tick();
  assert.equal(f.cancellations(), 1);
  f.results[0].resolve({ id: 'run', status: 'cancelled' });
  await harness.close();
  assert.equal(f.closes(), 1);
});

test('abort during cached native event replay has no unhandled rejection', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  await harness.handle(body, 'main', signal());
  const observer = new AbortController();
  await assert.rejects(
    harness.handle(body, 'main', observer.signal, () => {
      observer.abort(new Error('replay disconnected'));
    }),
    /replay disconnected/,
  );
  await tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.cancellations(), 0);
});

test('a committed native reply survives transport loss before terminal delivery', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  await assert.rejects(
    first.handle(body, 'main', signal(), (name) => {
      if (name === 'message_delta') {
        throw new Error('transport lost');
      }
    }),
    /transport lost/,
  );
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  assert.equal(saved.interrupted, false);
  assert.equal(saved.replay.events.at(-1)[0], 'message_stop');
  assert.deepEqual(await first.handle(body, 'main', signal()), replayedResponse(saved.response));
  await first.close();
  const second = f.make();
  const replayed: string[] = [];
  assert.deepEqual(
    await second.handle(body, 'main', signal(), (name) => replayed.push(name)),
    replayedResponse(saved.response),
  );
  assert.equal(replayed.at(-1), 'message_stop');
  assert.equal(f.sends.length, 1);
  assert.equal(f.resumed.length, 0);
  await second.handle(follow(saved.response), 'main', signal());
  assert.deepEqual(f.resumed, ['agent-1']);
  assert.equal(f.sends.length, 2);
});

test('a failed reply archive blocks the next send and can retry without repeating native work', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  const response = await first.handle(body, 'main', signal());
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  const archive = path.join(f.directory, 'state', `${saved.replay.key}.response.json`);
  await mkdir(archive);
  await assert.rejects(first.handle(follow(response), 'main', signal()));
  assert.equal(f.sends.length, 1);
  assert.equal(JSON.parse(await readFile(f.sessionFile, 'utf8')).interrupted, false);
  await rm(archive, { recursive: true });
  await first.handle(follow(response), 'main', signal());
  assert.equal(f.sends.length, 2);
  await first.close();
  assert.deepEqual(await f.make().handle(body, 'main', signal()), replayedResponse(response));
  assert.equal(f.sends.length, 2);
});

test('failed initial persistence closes the unused SDK agent and allows a safe startup retry', async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers<void>();
  f.delayCreate(gate.promise);
  const harness = f.make();
  const request = harness.handle(body, 'main', signal());
  await until(() => f.configurations.length > 0, 'the native configuration');
  await mkdir(f.sessionFile);
  gate.resolve();
  await assert.rejects(request);
  assert.equal(f.sends.length, 0);
  assert.equal(f.closes(), 1);
  await rm(f.sessionFile, { recursive: true });
  await harness.handle(body, 'main', signal());
  assert.equal(f.configurations.length, 2);
  assert.equal(f.sends.length, 1);
});

test('new native dispatches recheck policy files while cached replies remain replayable', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  const response = await first.handle(body, 'main', signal());
  const policy = path.join(f.directory, '.cursor', 'permissions.json');
  await mkdir(path.dirname(policy));
  await writeFile(policy, '{"deny":["Shell(rm)"]}');
  const cached = await first.handle(body, 'main', signal());
  assert.deepEqual(cached.usage, response.usage);
  assert.equal(cached.multi_usage?.source, response.multi_usage?.source);
  assert.equal(cached.multi_usage?.model, 'test-model');
  await assert.rejects(
    first.handle(follow(response), 'main', signal()),
    /permissions.json.*unsupported/,
  );
  assert.equal(f.sends.length, 1);
  await rm(policy);
  await first.handle(follow(response), 'main', signal());
  assert.equal(f.sends.length, 2);
  assert.equal(f.configurations.length, 1);
});

test('resumed history fingerprints ignore moved cache markers and send only the new turn', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  const initial: MessagesRequest = {
    ...body,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'private prior context', cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
  };
  const response = await first.handle(initial, 'main', signal());
  await first.close();
  const second = f.make();
  const continued: MessagesRequest = {
    ...body,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'private prior context' }] },
      {
        role: 'assistant',
        content: response.content.map((block) => ({
          ...block,
          cache_control: { type: 'ephemeral' },
        })),
      },
      { role: 'user', content: 'new turn only' },
    ],
  };
  const continuedResponse = await second.handle(continued, 'main', signal());
  assert.deepEqual(f.resumed, ['agent-1']);
  assert.equal(f.sends.length, 2);
  assert.match(JSON.stringify(f.sends[1].prompt), /new turn only/);
  assert.doesNotMatch(
    JSON.stringify(f.sends[1].prompt),
    /private prior context|Compacting context/,
  );
  assert.doesNotMatch(JSON.stringify(continuedResponse.content), /Outer history changed/);
});

test('malformed manifests fail before replay or SDK resume', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  await first.handle(body, 'main', signal());
  await first.close();
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  for (const patch of [
    { interrupted: 'not-boolean' },
    { replay: { key: 'invalid', events: [] } },
    {
      response: {
        id: 'fake',
        content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: {} }],
      },
    },
    { pendingRun: { key: 'invalid', model: 'x', inputTokens: 1 } },
  ]) {
    await writeFile(f.sessionFile, JSON.stringify({ ...saved, ...patch }));
    await assert.rejects(f.make().handle(body, 'main', signal()), /invalid state/);
  }
  assert.equal(f.sends.length, 1);
  assert.equal(f.resumed.length, 0);
});

test('a manifest with a foreign or missing version starts a fresh native agent', async (t) => {
  const f = await fixture(t);
  const first = f.make();
  await first.handle(body, 'main', signal());
  await first.close();
  const saved = JSON.parse(await readFile(f.sessionFile, 'utf8'));
  assert.equal(saved.version, 3);
  for (const patch of [{ version: 1 }, { version: undefined }]) {
    await writeFile(f.sessionFile, JSON.stringify({ ...saved, ...patch }));
    const harness = f.make();
    await harness.handle(body, 'main', signal());
    await harness.close();
  }
  assert.equal(f.configurations.length, 3, 'each foreign-version manifest starts a fresh agent');
  assert.equal(f.resumed.length, 0);
});

test('native execution requires explicit permission context', async () => {
  const harness = new CursorHarness(models);
  await assert.rejects(
    harness.handle(body, 'main', signal()),
    /explicit Claude permission context/,
  );
  await harness.close();
});

test('restart recovers a terminal SDK result without sending or resuming an agent', async (t) => {
  const f = await fixture(t);
  await interruptedManifest(f);
  f.recover({ id: 'run', status: 'finished', result: 'Recovered completed edit' });
  const harness = f.make();
  const response = await harness.handle(body, 'main', signal());
  assert.deepEqual(response.content, [{ type: 'text', text: 'Recovered completed edit' }]);
  assert.equal(JSON.parse(await readFile(f.sessionFile, 'utf8')).interrupted, false);
  assert.equal(f.sends.length, 1);
  assert.equal(f.resumed.length, 0);
  assert.deepEqual(f.recoveryReads, ['run']);
  await harness.handle(follow(response), 'main', signal());
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.resumed, ['agent-1']);
});

test('recovery that cannot produce a terminal result proceeds with the interrupted notice instead of refusing', async (t) => {
  const stillRunning = await fixture(t);
  await interruptedManifest(stillRunning);
  stillRunning.recover({ id: 'run', status: 'finished', result: 'unproven' }, 'running');
  await expectInterruptedRetry(stillRunning);
  assert.deepEqual(stillRunning.recoveryReads, ['run']);

  const foreign = await fixture(t);
  await interruptedManifest(foreign);
  foreign.recover({ id: 'run', status: 'finished', result: 'foreign' }, 'finished', 'other-agent');
  await expectInterruptedRetry(foreign);
  assert.deepEqual(foreign.recoveryReads, ['run']);

  const missingId = await fixture(t);
  await interruptedManifest(missingId);
  const saved = JSON.parse(await readFile(missingId.sessionFile, 'utf8'));
  delete saved.pendingRun.runId;
  await writeFile(missingId.sessionFile, JSON.stringify(saved));
  await expectInterruptedRetry(missingId);
  assert.equal(missingId.recoveryReads.length, 0, 'no run id means no SDK lookup is attempted');
});

test('a recovered but unfinished SDK run does not block a later retry and keeps native state', async (t) => {
  const f = await fixture(t);
  await interruptedManifest(f);
  f.recover({ id: 'run', status: 'error', error: { message: 'native action failed' } });
  const { harness, response } = await expectInterruptedRetry(f);
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.resumed, ['agent-1']);
  const next = await harness.handle(follow(response), 'main', signal());
  assert.equal(f.sends.length, 3);
  assert.doesNotMatch(JSON.stringify(f.sends[2].prompt), /previous turn was interrupted/);
  assert(next.content.every((block) => block.type === 'text'));
});

test('idle agent eviction retains disk state and resumes the original native agent', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  const first = await harness.handle(body, 'main', signal());
  for (let index = 0; index < 32; index++) {
    await harness.handle(body, `worker-${index}`, signal());
  }
  assert.equal(f.closes(), 1);
  await harness.handle(follow(first), 'main', signal());
  assert.equal(f.configurations.length, 33);
  assert.equal(f.resumed.at(-1), 'agent-1');
});

test('settled exchange eviction replays disk replies without repeating native work', async (t) => {
  const f = await fixture(t);
  const harness = f.make();
  let request = body;
  const first = await harness.handle(request, 'main', signal());
  let response = first;
  for (let index = 0; index < 256; index++) {
    request = {
      ...body,
      messages: [
        ...(request.messages ?? []),
        { role: 'assistant', content: response.content },
        { role: 'user', content: `turn ${index}` },
      ],
    };
    response = await harness.handle(request, 'main', signal());
  }
  assert.deepEqual(await harness.handle(body, 'main', signal()), replayedResponse(first));
  assert.equal(f.sends.length, 257);
});

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  AntigravityRunOptions,
  AntigravityRunResult,
} from '../../plugins/multi-antigravity/src/cli.ts';
import {
  AntigravityHarness,
  AntigravityProviderError,
} from '../../plugins/multi-antigravity/src/harness.ts';
import {
  checkAntigravityHooks,
  installAntigravityHook,
} from '../../plugins/multi-antigravity/src/hooks.ts';
import { antigravityCompactionDenyList } from '../../plugins/multi-antigravity/src/permissions.ts';
import {
  antigravityHistoryHash,
  prepareAntigravityRequest,
} from '../../plugins/multi-antigravity/src/request.ts';
import type { PermissionContext } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { removeTemporary } from '../temporary.ts';

const model = {
  id: 'gemini-test-low',
  model: 'multi/antigravity/gemini-test-low',
  label: 'Test',
  worker: 'antigravity-test',
};
const context: PermissionContext = { permissionMode: 'auto', cwd: process.cwd() };
const policy = async () => ({
  denied: ['run_command'],
  plan: false,
  notice: 'Native policy',
});

async function setup() {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-harness-'));
  const calls: AntigravityRunOptions[] = [];
  const run = async (options: AntigravityRunOptions) => {
    calls.push(options);
    options.onEvent?.({ event: 'step_update', step_update: { text_delta: 'hello' } });
    return {
      result: { conversation_id: 'conversation-1', status: 'SUCCESS' as const, response: 'hello' },
      exitCode: 0,
      signal: null,
      stderr: '',
    };
  };
  return { stateDirectory, calls, run };
}

test('Antigravity exposes native usage in the Messages response', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-usage-'));
  t.after(() => removeTemporary(stateDirectory));
  const harness = new AntigravityHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async () => ({
      result: {
        conversation_id: 'usage-conversation',
        status: 'SUCCESS' as const,
        response: 'native',
        usage: { input_tokens: 40, output_tokens: 9, thinking_tokens: 3, total_tokens: 49 },
      },
      exitCode: 0,
      signal: null,
      stderr: '',
    }),
  });
  t.after(() => harness.close());
  const response = await harness.handle(
    { model: model.model, messages: [{ role: 'user', content: 'usage' }] },
    'usage',
    new AbortController().signal,
    undefined,
    context,
  );
  assert.deepEqual(response.usage, { input_tokens: 40, output_tokens: 9 });
  assert.deepEqual(response.multi_usage, {
    source: 'provider',
    reasoning_tokens: 3,
    total_tokens: 49,
    model: 'gemini-test-low',
    effort: 'low',
  });
});

/** Bounded poll that sleeps between checks and fails with a reason. */
async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('Claude system content is never forwarded to the native prompt', async (t) => {
  const fixture = await setup();
  const harness = new AntigravityHarness([model], { ...fixture, checkPermissions: policy });
  t.after(() => harness.close());
  const first = {
    model: model.model,
    system: 'Keep the task scope',
    messages: [{ role: 'user', content: 'first' }],
  };
  const response = await harness.handle(
    first,
    'billing',
    new AbortController().signal,
    undefined,
    context,
  );
  const next = {
    ...first,
    system: 'Different instructions entirely',
    messages: [
      ...first.messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: 'next' },
    ],
  };
  await harness.handle(next, 'billing', new AbortController().signal, undefined, context);
  assert.equal(fixture.calls.length, 2);
  assert(!fixture.calls[0].prompt.includes('Keep the task scope'));
  assert(!fixture.calls[1].prompt.includes('Different instructions entirely'));
  assert.match(fixture.calls[0].prompt, /Antigravity coding agent/);
});

test('Antigravity replays completed requests and resumes native conversation', async (t) => {
  const setupResult = await setup();
  const harness = new AntigravityHarness([model], { ...setupResult, checkPermissions: policy });
  t.after(() => harness.close());
  const request = { model: model.model, messages: [{ role: 'user', content: 'first' }] };
  const events: string[] = [];
  const first = await harness.handle(
    request,
    'session/worker',
    new AbortController().signal,
    (name) => events.push(name),
    context,
  );
  assert.equal(first.content[0].type, 'text');
  assert.match(first.content[0].text, /hello/);
  assert.equal(setupResult.calls[0].effort, 'low');
  assert.deepEqual(events.slice(-2), ['message_delta', 'message_stop']);
  const replay = await harness.handle(
    request,
    'session/worker',
    new AbortController().signal,
    undefined,
    context,
  );
  assert.equal(replay.id, first.id);
  assert.equal(setupResult.calls.length, 1);
  const next = {
    model: model.model,
    messages: [
      ...request.messages,
      { role: 'assistant', content: first.content },
      { role: 'user', content: 'second' },
    ],
  };
  await harness.handle(next, 'session/worker', new AbortController().signal, undefined, context);
  assert.equal(setupResult.calls.length, 2);
  assert.equal(setupResult.calls[1].conversation, 'conversation-1');
});

test('the context tag is not part of a request identity', async (t) => {
  const setupResult = await setup();
  const harness = new AntigravityHarness([model], { ...setupResult, checkPermissions: policy });
  t.after(() => harness.close());
  const messages = [{ role: 'user', content: 'first' }];
  const tagged = await harness.handle(
    { model: `${model.model}[1m]`, messages },
    'session/worker',
    new AbortController().signal,
    undefined,
    context,
  );
  // The same native request under the plain spelling, which is what a launch sees once
  // MULTI_DISABLE_1M_CONTEXT is set. Replaying it must not dispatch the run a second time.
  const plain = await harness.handle(
    { model: model.model, messages },
    'session/worker',
    new AbortController().signal,
    undefined,
    context,
  );
  assert.equal(plain.id, tagged.id);
  assert.equal(setupResult.calls.length, 1);
});

test('an interrupted run keeps its native conversation and resumes with a notice', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-interrupted-'));
  const calls: AntigravityRunOptions[] = [];
  const run = async (options: AntigravityRunOptions) => {
    calls.push(options);
    if (calls.length === 1) {
      options.onEvent?.({ event: 'init', conversation_id: 'interrupted-conversation', init: {} });
      return new Promise<AntigravityRunResult>((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
      });
    }
    return {
      result: {
        conversation_id: 'interrupted-conversation',
        status: 'SUCCESS' as const,
        response: 'resumed',
      },
      exitCode: 0,
      signal: null,
      stderr: '',
    };
  };
  const harness = new AntigravityHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run,
  });
  const controller = new AbortController();
  const request = { model: model.model, messages: [{ role: 'user', content: 'uncertain' }] };
  const first = harness.handle(request, 'session/worker', controller.signal, undefined, context);
  // Abort only once the native run has started. Aborting earlier rejects the
  // request before `run` is called, and the shared fake would then hand its
  // never-settling first call to the resumed harness below.
  await until(() => calls.length === 1, 'the first native run to start');
  controller.abort();
  await assert.rejects(first);
  await harness.close();

  const resumed = new AntigravityHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run,
  });
  t.after(() => resumed.close());
  const second = await resumed.handle(
    { model: model.model, messages: [{ role: 'user', content: 'continue' }] },
    'session/worker',
    new AbortController().signal,
    undefined,
    context,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].conversation, 'interrupted-conversation');
  assert.match(calls[1].prompt, /previous turn was interrupted/);
  assert.equal(second.content[0].type, 'text');
  assert.match(second.content[0].text, /previous turn was interrupted/);

  const third = await resumed.handle(
    {
      model: model.model,
      messages: [
        { role: 'user', content: 'continue' },
        { role: 'assistant', content: second.content },
        { role: 'user', content: 'again' },
      ],
    },
    'session/worker',
    new AbortController().signal,
    undefined,
    context,
  );
  assert.equal(calls.length, 3);
  assert(!calls[2].prompt.includes('previous turn was interrupted'));
  assert(third.content[0].type === 'text');
  assert(!third.content[0].text.includes('previous turn was interrupted'));
});

test('an init event durably saves the conversation id and interrupted state before a terminal result', async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-durability-'));
  const run = async (options: AntigravityRunOptions): Promise<AntigravityRunResult> => {
    options.onEvent?.({ event: 'init', conversation_id: 'durable-conversation', init: {} });
    // Simulates a gateway crash: the run never settles on its own, only when
    // the harness is closed (below) and aborts it.
    return new Promise<AntigravityRunResult>((_, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), {
        once: true,
      });
    });
  };
  const harness = new AntigravityHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run,
  });
  const request = { model: model.model, messages: [{ role: 'user', content: 'crash mid-run' }] };
  const pending = harness.handle(
    request,
    'session/worker',
    new AbortController().signal,
    undefined,
    context,
  );
  void pending.catch(() => {});
  // The durability write is fire-and-forget; wait for it to land instead of
  // assuming a fixed delay covers a loaded machine.
  let sessionFile: string | undefined;
  await until(() => {
    sessionFile = readdirSync(stateDirectory).find((name) => name.endsWith('.session.json'));
    return sessionFile !== undefined;
  }, 'the durability write');
  assert(sessionFile, 'expected a persisted session file before the run settled');
  const saved = JSON.parse(await readFile(path.join(stateDirectory, sessionFile), 'utf8'));
  assert.equal(saved.conversationId, 'durable-conversation');
  assert.equal(saved.interrupted, true);

  await harness.close();
  await assert.rejects(pending);
});

test('an aborted run without a native conversation id starts fresh next time', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-no-init-'));
  const calls: AntigravityRunOptions[] = [];
  const run = async (options: AntigravityRunOptions) => {
    calls.push(options);
    if (calls.length === 1) {
      return new Promise<AntigravityRunResult>((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
      });
    }
    return {
      result: { conversation_id: 'fresh-conversation', status: 'SUCCESS' as const, response: 'ok' },
      exitCode: 0,
      signal: null,
      stderr: '',
    };
  };
  const harness = new AntigravityHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run,
  });
  const controller = new AbortController();
  const request = { model: model.model, messages: [{ role: 'user', content: 'never started' }] };
  const first = harness.handle(request, 'session/worker', controller.signal, undefined, context);
  // Abort only once the native run has started. Aborting earlier rejects the
  // request before `run` is called, and the shared fake would then hand its
  // never-settling first call to the resumed harness below.
  await until(() => calls.length === 1, 'the first native run to start');
  controller.abort();
  await assert.rejects(first);
  await harness.close();

  const resumed = new AntigravityHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run,
  });
  t.after(() => resumed.close());
  await resumed.handle(request, 'session/worker', new AbortController().signal, undefined, context);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].conversation, undefined);
  assert(!calls[1].prompt.includes('previous turn was interrupted'));
});

test('a non-SUCCESS terminal result is not persisted; an identical retry runs again', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-failure-'));
  let calls = 0;
  const run = async (_options: AntigravityRunOptions) => {
    calls++;
    return {
      result: {
        conversation_id: 'failed-conversation',
        status: 'ERROR' as const,
        response: '',
        error: 'native denial',
      },
      exitCode: 1,
      signal: null,
      stderr: '',
    };
  };
  const harness = new AntigravityHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run,
  });
  t.after(() => harness.close());
  const request = { model: model.model, messages: [{ role: 'user', content: 'will fail' }] };
  await assert.rejects(
    harness.handle(request, 'session/worker', new AbortController().signal, undefined, context),
    /native denial/,
  );
  await assert.rejects(
    harness.handle(request, 'session/worker', new AbortController().signal, undefined, context),
    /native denial/,
  );
  assert.equal(calls, 2);
});

test('continuation requires a new message and a new user turn after the last assistant reply', async (t) => {
  const setupResult = await setup();
  const harness = new AntigravityHarness([model], { ...setupResult, checkPermissions: policy });
  t.after(() => harness.close());
  const seed = { model: model.model, messages: [{ role: 'user', content: 'seed' }] };
  const first = await harness.handle(
    seed,
    'continuation-worker',
    new AbortController().signal,
    undefined,
    context,
  );
  await assert.rejects(
    harness.handle(
      {
        model: model.model,
        messages: [...seed.messages, { role: 'assistant', content: first.content }],
      },
      'continuation-worker',
      new AbortController().signal,
      undefined,
      context,
    ),
    /message after the last assistant turn/,
  );
  await assert.rejects(
    harness.handle(
      {
        model: model.model,
        messages: [
          ...seed.messages,
          { role: 'assistant', content: first.content },
          { role: 'system', content: 'a reminder with no new user turn' },
        ],
      },
      'continuation-worker',
      new AbortController().signal,
      undefined,
      context,
    ),
    /new user message/,
  );
});

test('outer history changes stream a rewind notice and continue on the native record', async (t) => {
  const setupResult = await setup();
  const harness = new AntigravityHarness([model], { ...setupResult, checkPermissions: policy });
  t.after(() => harness.close());
  await harness.handle(
    { model: model.model, messages: [{ role: 'user', content: 'seed' }] },
    'rewind-worker',
    new AbortController().signal,
    undefined,
    context,
  );
  const changed = await harness.handle(
    {
      model: model.model,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'a different remembered reply' }] },
        { role: 'user', content: 'continue' },
      ],
    },
    'rewind-worker',
    new AbortController().signal,
    undefined,
    context,
  );
  assert.equal(setupResult.calls.length, 2);
  assert(changed.content[0].type === 'text');
  assert.match(changed.content[0].text, /Outer history changed; the native conversation continues/);
});

test('authenticated compaction ignores Claude system content and disables tools', async (t) => {
  const setupResult = await setup();
  const harness = new AntigravityHarness([model], { ...setupResult, checkPermissions: policy });
  t.after(() => harness.close());
  const firstRequest = {
    model: model.model,
    system: 'original instructions',
    messages: [{ role: 'user', content: 'seed' }],
  };
  await harness.handle(
    firstRequest,
    'compaction-worker',
    new AbortController().signal,
    undefined,
    context,
  );
  const compact = await harness.handle(
    {
      model: model.model,
      system: 'Claude summary instructions',
      messages: [{ role: 'user', content: 'summarized outer history' }],
    },
    'compaction-worker',
    new AbortController().signal,
    undefined,
    { ...context, compaction: 'authenticated-compaction' },
  );
  assert.equal(setupResult.calls.length, 2);
  assert.deepEqual(
    JSON.parse(setupResult.calls[1].env?.MULTI_ANTIGRAVITY_DENY ?? '[]'),
    antigravityCompactionDenyList(),
  );
  assert(!setupResult.calls[1].prompt.includes('Claude summary instructions'));
  assert.match(setupResult.calls[1].prompt, /summarized outer history/);
  assert(compact.content[0].type === 'text');
  assert.match(compact.content[0].text, /Compaction summary; native tools disabled/);
});

test('a changed native policy emits its new mode notice', async (t) => {
  const setupResult = await setup();
  const harness = new AntigravityHarness([model], {
    ...setupResult,
    checkPermissions: async (_cwd, activeContext) => ({
      denied: [],
      plan: activeContext.permissionMode === 'plan',
      notice: `mode=${activeContext.permissionMode}`,
    }),
  });
  t.after(() => harness.close());
  const firstRequest = { model: model.model, messages: [{ role: 'user', content: 'mode seed' }] };
  const first = await harness.handle(
    firstRequest,
    'mode-worker',
    new AbortController().signal,
    undefined,
    context,
  );
  const second = await harness.handle(
    {
      model: model.model,
      messages: [
        ...firstRequest.messages,
        { role: 'assistant', content: first.content },
        { role: 'user', content: 'mode follow-up' },
      ],
    },
    'mode-worker',
    new AbortController().signal,
    undefined,
    { ...context, permissionMode: 'acceptEdits' },
  );
  assert.equal(second.content[0].type, 'text');
  assert.match(second.content[0].text, /mode=acceptEdits/);
});

test('compacted history retains inline system reminders after its response anchor', async (t) => {
  const setupResult = await setup();
  const harness = new AntigravityHarness([model], { ...setupResult, checkPermissions: policy });
  t.after(() => harness.close());
  const firstRequest = { model: model.model, messages: [{ role: 'user', content: 'seed' }] };
  const first = await harness.handle(
    firstRequest,
    'inline-system-worker',
    new AbortController().signal,
    undefined,
    context,
  );
  await assert.doesNotReject(
    harness.handle(
      {
        model: model.model,
        messages: [
          { role: 'assistant', content: first.content },
          { role: 'user', content: 'compacted summary' },
          { role: 'system', content: 'continue with the saved native state' },
        ],
      },
      'inline-system-worker',
      new AbortController().signal,
      undefined,
      context,
    ),
  );
  assert.equal(setupResult.calls.length, 2);
});

test('request preparation rejects unsupported content and hashes cache metadata away', async () => {
  assert.throws(
    () => prepareAntigravityRequest({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }),
    /does not support content block image/,
  );
  assert.throws(
    () =>
      prepareAntigravityRequest({
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool', content: [{ type: 'image' }] }],
          },
        ],
      }),
    /does not support content block image/,
  );
  assert.throws(
    () =>
      prepareAntigravityRequest({
        messages: [{ role: 'user', content: [{ type: 'tool_use', id: 'tool', name: 'Read' }] }],
      }),
    /requires assistant tool_use blocks/,
  );
  const first = [
    { role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] },
  ];
  const second = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
  assert.equal(antigravityHistoryHash(first), antigravityHistoryHash(second));
  const prepared = prepareAntigravityRequest({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private reasoning', signature: 'provider-secret' },
          { type: 'text', text: 'visible answer' },
        ],
      },
      { role: 'user', content: 'continue' },
    ],
  });
  assert.match(prepared.prompt, /visible answer/);
  assert.doesNotMatch(prepared.prompt, /private reasoning|provider-secret/);
});

test('a failed native policy check clears ownership for a later retry', async (t) => {
  const setupResult = await setup();
  let allowed = false;
  const harness = new AntigravityHarness([model], {
    ...setupResult,
    checkPermissions: async () => {
      if (!allowed) {
        throw new Error('policy unavailable');
      }
      return policy();
    },
  });
  t.after(() => harness.close());
  const request = { model: model.model, messages: [{ role: 'user', content: 'retry' }] };
  await assert.rejects(
    harness.handle(request, 'session/worker', new AbortController().signal, undefined, context),
    /policy unavailable/,
  );
  allowed = true;
  await assert.doesNotReject(
    harness.handle(request, 'session/worker', new AbortController().signal, undefined, context),
  );
  assert.equal(setupResult.calls.length, 1);
});

test('scope and workspace are part of native state ownership', async (t) => {
  const setupResult = await setup();
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agy-workspace-'));
  const canonicalWorkspace = await realpath(workspace);
  const harness = new AntigravityHarness([model], {
    ...setupResult,
    checkPermissions: policy,
  });
  t.after(() => harness.close());
  const request = { model: model.model, messages: [{ role: 'user', content: 'isolated' }] };
  const workspaceContext = { ...context, cwd: workspace };
  await harness.handle(
    request,
    'session/worker-a',
    new AbortController().signal,
    undefined,
    workspaceContext,
  );
  await harness.handle(
    request,
    'session/worker-b',
    new AbortController().signal,
    undefined,
    workspaceContext,
  );
  assert.equal(setupResult.calls.length, 2);
  assert.equal(setupResult.calls[0].cwd, canonicalWorkspace);
  assert.equal(setupResult.calls[1].cwd, canonicalWorkspace);
});

test('resumed native usage is reported as the turn delta', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-usage-'));
  let count = 0;
  const harness = new AntigravityHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (_options) => {
      count++;
      return {
        result: {
          conversation_id: 'usage-conversation',
          status: 'SUCCESS' as const,
          response: `reply-${count}`,
          usage: { input_tokens: count * 10, output_tokens: count * 4 },
        },
        exitCode: 0,
        signal: null,
        stderr: '',
      };
    },
  });
  t.after(() => harness.close());
  const firstRequest = { model: model.model, messages: [{ role: 'user', content: 'usage' }] };
  const first = await harness.handle(
    firstRequest,
    'usage-worker',
    new AbortController().signal,
    undefined,
    context,
  );
  const secondRequest = {
    model: model.model,
    messages: [
      ...firstRequest.messages,
      { role: 'assistant', content: first.content },
      { role: 'user', content: 'again' },
    ],
  };
  const second = await harness.handle(
    secondRequest,
    'usage-worker',
    new AbortController().signal,
    undefined,
    context,
  );
  assert.equal(first.usage.input_tokens, 10);
  assert.equal(second.usage.input_tokens, 10);
  assert.equal(second.usage.output_tokens, 4);
});

test('terminal events wait for the completed response ledger', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-terminal-'));
  const events: string[] = [];
  const harness = new AntigravityHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async () => {
      await rm(stateDirectory, { recursive: true, force: true });
      return {
        result: {
          conversation_id: 'terminal-conversation',
          status: 'SUCCESS' as const,
          response: 'reply',
        },
        exitCode: 0,
        signal: null,
        stderr: '',
      };
    },
  });
  t.after(() => harness.close());
  await assert.rejects(
    harness.handle(
      { model: model.model, messages: [{ role: 'user', content: 'durability' }] },
      'terminal-worker',
      new AbortController().signal,
      (name) => events.push(name),
      context,
    ),
  );
  assert.equal(events.includes('message_delta'), false);
  assert.equal(events.includes('message_stop'), false);
});

test('native admission requires our installed hook and rejects custom model settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-hooks-'));
  const globalFile = path.join(root, 'global', 'hooks.json');
  const settingsFile = path.join(root, 'settings.json');

  await assert.rejects(
    checkAntigravityHooks({ globalFile, settingsFile }),
    /requires its native permission hook/,
  );

  await installAntigravityHook(globalFile);
  await assert.doesNotReject(checkAntigravityHooks({ globalFile, settingsFile }));

  await writeFile(settingsFile, JSON.stringify({ modelProvider: 'custom' }));
  await assert.rejects(
    checkAntigravityHooks({ globalFile, settingsFile }),
    /custom provider settings are unsupported/,
  );
});

test('an unrelated active PreToolUse hook does not block native admission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-hooks-'));
  const globalFile = path.join(root, 'global', 'hooks.json');
  const settingsFile = path.join(root, 'settings.json');
  await mkdir(path.dirname(globalFile), { recursive: true });
  await writeFile(
    globalFile,
    JSON.stringify({
      other: {
        PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'other' }] }],
      },
    }),
  );
  await installAntigravityHook(globalFile);
  await assert.doesNotReject(checkAntigravityHooks({ globalFile, settingsFile }));
});

test('a prompt sent during a run is refused instead of resuming stale history', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-busy-'));
  t.after(() => removeTemporary(stateDirectory));
  const calls: AntigravityRunOptions[] = [];
  const release = Promise.withResolvers<void>();
  const harness = new AntigravityHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options: AntigravityRunOptions): Promise<AntigravityRunResult> => {
      calls.push(options);
      options.onEvent?.({ event: 'init', conversation_id: 'busy-conversation', init: {} });
      if (calls.length === 1) {
        await release.promise;
      }
      return {
        result: {
          conversation_id: 'busy-conversation',
          status: 'SUCCESS' as const,
          response: 'done',
        },
        exitCode: 0,
        signal: null,
        stderr: '',
      };
    },
  });
  t.after(async () => {
    release.resolve();
    await harness.close();
  });

  const first = harness.handle(
    { model: model.model, messages: [{ role: 'user', content: 'long running' }] },
    'busy-worker',
    new AbortController().signal,
    undefined,
    context,
  );
  await until(() => calls.length === 1, 'the first native run to start');

  // This prompt was written before the answer existed, so its history stops at the
  // running turn; resuming with it would send that turn to agy a second time.
  await assert.rejects(
    harness.handle(
      {
        model: model.model,
        messages: [
          { role: 'user', content: 'long running' },
          { role: 'user', content: 'typed while busy' },
        ],
      },
      'busy-worker',
      new AbortController().signal,
      undefined,
      context,
    ),
    (error: unknown) => {
      assert.equal(error instanceof AntigravityProviderError, true);
      assert.match((error as AntigravityProviderError).message, /already running/);
      // Deterministic while the run lasts: a retryable status turned one conflict
      // into ten attempts in a live session.
      assert.equal((error as AntigravityProviderError).failure.status, 400);
      return true;
    },
  );
  assert.equal(calls.length, 1, 'the refused prompt must not start a native run');

  release.resolve();
  const answer = await first;

  // The run in flight is untouched, and the next prompt resumes the conversation it opened.
  await harness.handle(
    {
      model: model.model,
      messages: [
        { role: 'user', content: 'long running' },
        { role: 'assistant', content: answer.content },
        { role: 'user', content: 'after the refusal' },
      ],
    },
    'busy-worker',
    new AbortController().signal,
    undefined,
    context,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].conversation, 'busy-conversation');
});

test('a first-load race is refused with 400, not a retryable gateway failure', async (t) => {
  const { stateDirectory, calls, run } = await setup();
  t.after(() => removeTemporary(stateDirectory));
  const harness = new AntigravityHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run,
  });
  t.after(() => harness.close());
  // Two distinct requests on the same agent, started before either has cached a
  // record: the second reaches `loadOnly` while the first still holds the load.
  const requests = [
    harness.handle(
      { model: model.model, messages: [{ role: 'user', content: 'first' }] },
      'race-worker',
      new AbortController().signal,
      undefined,
      context,
    ),
    harness.handle(
      { model: model.model, messages: [{ role: 'user', content: 'second' }] },
      'race-worker',
      new AbortController().signal,
      undefined,
      context,
    ),
  ];
  const settled = await Promise.allSettled(requests);
  const refused = settled.filter((outcome) => outcome.status === 'rejected');
  assert.equal(refused.length, 1, `expected exactly one refusal, got ${JSON.stringify(settled)}`);
  const error = refused[0].reason;
  assert(error instanceof AntigravityProviderError);
  // A bare HarnessBusyError escapes as a retryable 502, which Claude re-sends.
  assert.equal(error.failure.status, 400);
  assert.match(error.message, /already (running|loading)/);
  assert.equal(calls.length, 1, 'the refused request must not start a native run');
});

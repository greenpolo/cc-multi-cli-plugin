import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { InteractionUpdate, Run, RunResult, SendOptions } from '@cursor/sdk';
import type {
  Emit,
  MessagesRequest,
  ResponseContentBlock,
} from '../../plugins/multi-core/src/gateway/messages.ts';
import { ModBridge } from '../../plugins/multi-core/src/gateway/mod-bridge.ts';
import { CursorHarness } from '../../plugins/multi-cursor/src/harness.ts';
import { cursorModelOptions } from '../../plugins/multi-cursor/src/models.ts';
import { removeTemporary } from '../temporary.ts';

const models = cursorModelOptions([{ id: 'row-test', displayName: 'Rows' }]);
const names = ['read', 'search', 'edit', 'shell', 'other', 'note'].map(
  (name) => `mcp__multi-core__cursor_${name}`,
);
const body: MessagesRequest = {
  model: models[0].model,
  stream: true,
  tools: names.map((name) => ({ name, input_schema: { type: 'object' } })),
  messages: [{ role: 'user', content: 'inspect the fixture' }],
};

function capture() {
  const events: Array<[string, unknown]> = [];
  const content: ResponseContentBlock[] = [];
  const emit: Emit = (name, value) => {
    events.push([name, structuredClone(value)]);
    if ('content_block' in value) {
      content[value.index] = structuredClone(value.content_block);
    }
  };
  return { events, content, emit };
}

function fakeRun(gate: Promise<RunResult>, cancel: () => void): Run {
  return {
    id: 'run-row',
    agentId: 'agent-row',
    status: 'running',
    wait: () => gate,
    cancel: async () => {
      cancel();
    },
    async *stream() {},
    conversation: async () => [],
    supports: () => true,
    unsupportedReason: () => undefined,
    onDidChangeStatus: () => () => {},
  };
}

async function harnessFixture(
  t: test.TestContext,
  updates: Array<{ update: InteractionUpdate }>,
  hold = false,
) {
  let sends = 0;
  let cancelCount = 0;
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<RunResult>();
  const createAgent = async () => ({
    agentId: 'agent-row',
    close() {},
    async send(_prompt: unknown, options?: SendOptions) {
      sends++;
      started.resolve();
      for (const update of updates) {
        await options?.onDelta?.(update);
      }
      if (!hold) {
        gate.resolve({ id: 'run-row', status: 'finished', result: 'done' });
      }
      return fakeRun(gate.promise, () => {
        cancelCount++;
        gate.resolve({ id: 'run-row', status: 'cancelled' });
      });
    },
  });
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'native-mod-rows-'));
  const harness = new CursorHarness(models, {
    cwd: process.cwd(),
    stateDirectory,
    createAgent,
    resumeAgent: createAgent,
  });
  t.after(async () => {
    await harness.close();
    await removeTemporary(stateDirectory);
  });
  return {
    harness,
    gate,
    started: started.promise,
    sends: () => sends,
    cancelCount: () => cancelCount,
  };
}

test('ModBridge emits completed rows in order with tool-call-answerable input', () => {
  const bridge = new ModBridge();
  const key = JSON.stringify(['session', 'main']);
  bridge.observe(key, { type: 'started', id: 'a', kind: 'read', description: 'a.txt' });
  bridge.observe(key, { type: 'started', id: 'b', kind: 'shell', description: 'echo b' });
  const first = bridge.observe(key, { type: 'completed', id: 'a', text: 'A', error: false });
  const second = bridge.observe(key, { type: 'completed', id: 'b', text: 'B', error: true });
  assert.deepEqual(first?.input, {
    description: 'a.txt',
    output: 'A',
    isError: false,
    toolUseId: 'a',
  });
  assert.deepEqual(second?.input, {
    description: 'echo b',
    output: 'B',
    isError: true,
    toolUseId: 'b',
  });
  assert.equal(first?.tool, 'mcp__multi-core__cursor_read');
  assert.equal(second?.sequence, 2);
});

test('Cursor stream contains ordered display blocks and completed exchange replays without a send', async (t) => {
  const updates: Array<{ update: InteractionUpdate }> = [
    {
      update: {
        type: 'tool-call-started',
        callId: 'read',
        modelCallId: 'm',
        toolCall: { type: 'read', args: { path: 'a.txt' } },
      },
    },
    {
      update: {
        type: 'tool-call-completed',
        callId: 'read',
        modelCallId: 'm',
        toolCall: {
          type: 'read',
          args: { path: 'a.txt' },
          result: { status: 'success', value: { fileSize: 1, content: 'A', totalLines: 1 } },
        },
      },
    },
    { update: { type: 'text-delta', text: 'done' } },
  ];
  const f = await harnessFixture(t, updates);
  const bridge = new ModBridge();
  const first = capture();
  const result = f.harness.handle(
    body,
    'session/main',
    new AbortController().signal,
    first.emit,
    { permissionMode: 'plan' },
    (observation) => bridge.observe('session/main', observation),
  );
  const response = await (async () => {
    const value = await result;
    return value;
  })();
  const tool = response.content.find((item) => item.type === 'tool_use');
  assert(tool && tool.type === 'tool_use');
  assert.equal(tool.name, 'mcp__multi-core__cursor_read');
  assert.deepEqual(tool.input, {
    description: 'read: a.txt',
    output: '[Cursor] read: a.txt completed.',
    isError: false,
    toolUseId: 'read',
  });
  assert.equal(f.sends(), 1);
  const replay = capture();
  await f.harness.handle(
    body,
    'session/main',
    new AbortController().signal,
    replay.emit,
    { permissionMode: 'plan' },
    (observation) => bridge.observe('session/main', observation),
  );
  assert.equal(f.sends(), 1);
  assert.deepEqual(replay.content, first.content);
});

test('closing the request aborts the native run', async (t) => {
  const updates: Array<{ update: InteractionUpdate }> = [
    { update: { type: 'text-delta', text: 'working' } },
  ];
  const f = await harnessFixture(t, updates, true);
  const controller = new AbortController();
  const running = f.harness.handle(
    body,
    'cancel/main',
    controller.signal,
    undefined,
    { permissionMode: 'plan' },
    undefined,
  );
  await f.started;
  controller.abort(new Error('connection closed'));
  await assert.rejects(running);
  assert.equal(f.cancelCount(), 1);
});

test('missing or denied display tools disable row transport', () => {
  const bridge = new ModBridge();
  assert.equal(bridge.available(body), true);
  assert.equal(bridge.available({ ...body, tools: body.tools?.slice(1) }), false);
  assert.equal(bridge.available({ ...body, tools: [{ name: names[0], input_schema: {} }] }), false);
  assert.equal(
    bridge.observe('denied', { type: 'completed', id: 'x', text: 'x', error: true }),
    undefined,
  );
});

test('a mod-row reply replays from the session record and from its archived response file', async (t) => {
  const updates: Array<{ update: InteractionUpdate }> = [
    {
      update: {
        type: 'tool-call-started',
        callId: 'read',
        modelCallId: 'm',
        toolCall: { type: 'read', args: { path: 'a.txt' } },
      },
    },
    {
      update: {
        type: 'tool-call-completed',
        callId: 'read',
        modelCallId: 'm',
        toolCall: {
          type: 'read',
          args: { path: 'a.txt' },
          result: { status: 'success', value: { fileSize: 1, content: 'A', totalLines: 1 } },
        },
      },
    },
    { update: { type: 'text-delta', text: 'done' } },
  ];
  let sends = 0;
  const createAgent = async () => ({
    agentId: 'agent-row',
    close() {},
    async send(_prompt: unknown, options?: SendOptions) {
      sends++;
      for (const update of updates) {
        await options?.onDelta?.(update);
      }
      const finished = Promise.resolve<RunResult>({
        id: `run-${sends}`,
        status: 'finished',
        result: 'done',
      });
      return fakeRun(finished, () => {});
    },
  });
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'native-mod-rows-replay-'));
  const harnesses: CursorHarness[] = [];
  const make = () => {
    const harness = new CursorHarness(models, {
      cwd: process.cwd(),
      stateDirectory,
      createAgent,
      resumeAgent: createAgent,
    });
    harnesses.push(harness);
    return harness;
  };
  t.after(async () => {
    await Promise.all(harnesses.map((harness) => harness.close()));
    await removeTemporary(stateDirectory);
  });
  const bridge = new ModBridge();
  const observe = (observation: Parameters<ModBridge['observe']>[1]) =>
    bridge.observe('replay/main', observation);
  const context = { permissionMode: 'plan' as const };
  const live = capture();
  const first = make();
  const answer = await first.handle(
    body,
    'replay/main',
    new AbortController().signal,
    live.emit,
    context,
    observe,
  );
  assert(answer.content.some((block) => block.type === 'tool_use'));
  await first.close();

  // A fresh harness has neither the exchange nor the cached record, so the reply
  // has to survive the session record's own validation before it can be replayed.
  const second = make();
  const fromRecord = capture();
  const replayed = await second.handle(
    body,
    'replay/main',
    new AbortController().signal,
    fromRecord.emit,
    context,
    observe,
  );
  assert.equal(sends, 1, 'a persisted display row must never be answered by a second native run');
  assert.deepEqual(fromRecord.content, live.content);
  assert.equal(replayed.multi_usage?.replayed, true);

  // The next turn moves that reply out of the record and into its own file.
  await second.handle(
    {
      ...body,
      messages: [
        ...(body.messages ?? []),
        { role: 'assistant', content: replayed.content },
        { role: 'user', content: 'and again' },
      ],
    },
    'replay/main',
    new AbortController().signal,
    undefined,
    context,
    observe,
  );
  assert.equal(sends, 2);
  await second.close();
  const third = make();
  const fromFile = capture();
  await third.handle(
    body,
    'replay/main',
    new AbortController().signal,
    fromFile.emit,
    context,
    observe,
  );
  assert.equal(sends, 2);
  assert.deepEqual(fromFile.content, live.content);
});

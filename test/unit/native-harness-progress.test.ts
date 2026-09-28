import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  AntigravityRunOptions,
  AntigravityStreamEvent,
} from '../../plugins/multi-antigravity/src/cli.ts';
import { AntigravityHarness } from '../../plugins/multi-antigravity/src/harness.ts';
import {
  ANTIGRAVITY_TOOLS,
  observeAntigravityInit,
  observeAntigravityStep,
} from '../../plugins/multi-antigravity/src/progress.ts';
import { DisplayRows, ROW_TOKEN } from '../../plugins/multi-core/src/gateway/display-rows.ts';
import {
  NativeActionTracker,
  type NativeObservation,
} from '../../plugins/multi-core/src/gateway/harness-progress.ts';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import { ModBridge } from '../../plugins/multi-core/src/gateway/mod-bridge.ts';
import type { PermissionContext } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import type { NativeHarness } from '../../plugins/multi-core/src/gateway/native-harness.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import type { GrokRunOptions } from '../../plugins/multi-grok/src/cli.ts';
import { GrokHarness } from '../../plugins/multi-grok/src/harness.ts';
import { GROK_TOOLS, grokPermissionPolicy } from '../../plugins/multi-grok/src/permissions.ts';
import { observeGrokEvent } from '../../plugins/multi-grok/src/progress.ts';
import { removeTemporary } from '../temporary.ts';

const context: PermissionContext = { permissionMode: 'auto', cwd: process.cwd() };
const agyModel = {
  id: 'gemini-test-low',
  model: 'multi/antigravity/gemini-test-low',
  label: 'Test',
};
const grokModel = {
  id: 'grok-4.6',
  model: 'multi/grok/grok-4.6',
  label: 'Grok 4.6',
  default: true,
};

function tracker() {
  const seen: NativeObservation[] = [];
  const rows: string[] = [];
  const actions = new NativeActionTracker(
    'Native',
    (item) => {
      seen.push(item);
      return item.type === 'completed'
        ? {
            type: 'tool_use',
            id: `row-${item.id}`,
            name: `mcp__multi-core__${item.row.tool}`,
            input: {},
          }
        : undefined;
    },
    (block) => rows.push(block.id),
  );
  return { seen, rows, actions };
}

function action(kind: 'read' | 'edit' | 'shell', tool: string, description: string) {
  return { kind, tool, input: {}, description };
}

test('the shared tracker pairs actions once and writes one bounded summary', () => {
  const { seen, rows, actions } = tracker();
  actions.start('a', { ...action('edit', 'write', 'edit: a.ts'), changed: 'a.ts' });
  actions.start('a', action('edit', 'write', 'duplicate'));
  actions.start('b', action('shell', 'run', `npm test${String.fromCharCode(27)}[31m\nred`));
  actions.start('c', action('read', 'view', 'read: c.ts'));
  actions.finish('a', { outcome: 'done', error: false });
  actions.finish('a', { outcome: 'again', error: true });
  actions.finish('b', { outcome: 'refused', output: 'Denied by policy', error: true });
  actions.finish('unknown', { outcome: 'done', error: false });
  assert.deepEqual(
    seen.flatMap((item) => {
      if (item.type === 'toolset') {
        return [];
      }
      return [
        item.type === 'started' ? [item.type, item.id, item.description] : [item.type, item.id],
      ];
    }),
    [
      ['started', 'a', 'edit: a.ts'],
      ['started', 'b', 'npm test red'],
      ['started', 'c', 'read: c.ts'],
      ['completed', 'a'],
      ['completed', 'b'],
    ],
  );
  const refused = seen.find((item) => item.type === 'completed' && item.id === 'b');
  assert.deepEqual(refused?.type === 'completed' && refused.row, {
    tool: 'run',
    input: {},
    output: 'Denied by policy',
    error: true,
  });
  assert.deepEqual(rows, ['row-a', 'row-b']);
  assert.equal(
    actions.text(),
    '\n\n[Native] 3 native actions: 1 edit, 1 shell, 1 read.\n' +
      '[Native] Changed: a.ts.\n[Native] Not completed: npm test red (refused).\n' +
      '[Native] Unconfirmed: 1 action ended without a reported outcome.\n',
  );
  assert.equal(new NativeActionTracker('Native').text(), '');
});

test('an action whose completion never arrives is settled when the run ends, not left running', () => {
  const { seen, rows, actions } = tracker();
  actions.start('lost', action('read', 'view_file', 'view_file: a.ts'));
  actions.settle();
  const settled = seen.at(-1);
  assert.ok(settled?.type === 'completed');
  assert.equal(settled.id, 'lost');
  assert.equal(settled.outcome, 'ended without a reported outcome');
  assert.equal(settled.error, false);
  assert.match(settled.row.output, /without reporting this action's completion/);
  assert.deepEqual(rows, ['row-lost'], 'the settled action still gets its row');
  // Settling twice, or the summary after it, reports nothing more.
  actions.settle();
  assert.match(actions.text(), /1 native action: 1 read\./);
  assert.equal(seen.filter((item) => item.type === 'completed').length, 1);
});

test('Antigravity tool steps map to native names, parameters and output, keyed by step index', () => {
  const { seen, actions } = tracker();
  let fallback = 0;
  const next = () => `tool-${++fallback}`;
  observeAntigravityStep({ text_delta: 'thinking' }, actions, next);
  observeAntigravityStep(
    {
      step_index: 2,
      tool_name: 'view_file',
      state: 'ACTIVE',
      tool_info: { name: 'view_file', parameters: { AbsolutePath: '/w/a.ts' } },
    },
    actions,
    next,
  );
  observeAntigravityStep(
    {
      step_index: 2,
      tool_name: 'view_file',
      state: 'DONE',
      duration_seconds: 1,
      tool_info: { name: 'view_file', parameters: { AbsolutePath: '/w/a.ts' }, output: '1 line' },
    },
    actions,
    next,
  );
  observeAntigravityStep(
    { step_index: 3, tool_name: 'run_command', state: 'ERROR', tool_info: { CommandLine: 'ls' } },
    actions,
    next,
  );
  observeAntigravityStep({ tool_name: 'grep_search' }, actions, next);
  assert.deepEqual(seen, [
    {
      type: 'started',
      id: 'step-2',
      kind: 'read',
      tool: 'view_file',
      description: 'view_file: /w/a.ts',
    },
    {
      type: 'completed',
      id: 'step-2',
      kind: 'read',
      outcome: 'done · 1s',
      error: false,
      row: {
        tool: 'view_file',
        input: { AbsolutePath: '/w/a.ts' },
        output: '1 line',
        error: false,
      },
    },
    {
      type: 'started',
      id: 'step-3',
      kind: 'shell',
      tool: 'run_command',
      description: 'run_command: ls',
    },
    {
      type: 'completed',
      id: 'step-3',
      kind: 'shell',
      outcome: 'error',
      error: true,
      row: { tool: 'run_command', input: { CommandLine: 'ls' }, output: 'ERROR', error: true },
    },
    {
      type: 'started',
      id: 'tool-1',
      kind: 'search',
      tool: 'grep_search',
      description: 'grep_search',
    },
  ]);
});

/** Replays a captured `agy --output-format stream-json` run through the progress mapping. */
function replayFixture(name: string) {
  const { seen, actions } = tracker();
  const file = path.join(import.meta.dirname, 'fixtures', 'antigravity', name);
  let fallback = 0;
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const event = JSON.parse(line) as AntigravityStreamEvent;
    if (event.event === 'init') {
      observeAntigravityInit(event.init, actions);
    } else if (event.event === 'step_update') {
      observeAntigravityStep(event.step_update, actions, () => `tool-${++fallback}`);
    }
  }
  return { seen, summary: actions.text() };
}

function fixtureActions(seen: NativeObservation[]) {
  return seen.flatMap((item) => {
    if (item.type === 'started') {
      return [['started', item.id, item.tool]];
    }
    if (item.type === 'completed') {
      return [['completed', item.id, item.row.tool, item.row.input, item.row.output, item.error]];
    }
    return [];
  });
}

test('the captured agy runs map to exactly their native actions, the failing command with its output', () => {
  const success = replayFixture('stream-success.jsonl');
  const toolset = success.seen[0];
  assert.ok(toolset?.type === 'toolset');
  assert.deepEqual(toolset.tools, ANTIGRAVITY_TOOLS);
  assert.deepEqual(fixtureActions(success.seen), [
    ['started', 'step-2', 'view_file'],
    [
      'completed',
      'step-2',
      'view_file',
      { AbsolutePath: '/work/project/note.txt' },
      '2 lines, 6 bytes',
      false,
    ],
    ['started', 'step-4', 'run_command'],
    ['completed', 'step-4', 'run_command', { CommandLine: 'echo hi' }, 'hi\r\n', false],
  ]);
  assert.equal(success.summary, '\n\n[Native] 2 native actions: 1 read, 1 shell.\n');

  const failure = replayFixture('stream-failure.jsonl');
  assert.deepEqual(fixtureActions(failure.seen), [
    ['started', 'step-2', 'run_command'],
    [
      'completed',
      'step-2',
      'run_command',
      { CommandLine: 'cat /nonexistent/file' },
      'cat: /nonexistent/file: No such file or directory\r\n',
      false,
    ],
    ['started', 'step-4', 'view_file'],
    [
      'completed',
      'step-4',
      'view_file',
      { AbsolutePath: '/work/project/note.txt' },
      '2 lines, 6 bytes',
      false,
    ],
  ]);
});

test('Grok tool calls map to native names, raw input and output, and name refusals', () => {
  const { seen, actions } = tracker();
  observeGrokEvent({ event: 'tools', tools: ['read_file', 'search_replace'] }, actions);
  observeGrokEvent({ event: 'text', text: 'hi' }, actions);
  observeGrokEvent(
    {
      event: 'tool_call',
      call: {
        toolCallId: 'e',
        toolName: 'search_replace',
        kind: 'edit',
        title: 'Edit a.ts',
        rawInput: { path: 'a.ts' },
      },
    },
    actions,
  );
  observeGrokEvent(
    { event: 'tool_update', call: { toolCallId: 'e', status: 'completed', rawOutput: 'patched' } },
    actions,
  );
  observeGrokEvent(
    {
      event: 'tool_update',
      call: {
        toolCallId: 'x',
        toolName: 'run_terminal_command',
        kind: 'execute',
        title: 'rm -rf',
        status: 'failed',
        content: [{ content: { text: 'Denied by permission policy' } }],
      },
    },
    actions,
  );
  assert.deepEqual(seen, [
    { type: 'toolset', tools: ['read_file', 'search_replace'] },
    { type: 'started', id: 'e', kind: 'edit', tool: 'search_replace', description: 'Edit a.ts' },
    {
      type: 'completed',
      id: 'e',
      kind: 'edit',
      outcome: 'done',
      error: false,
      row: { tool: 'search_replace', input: { path: 'a.ts' }, output: 'patched', error: false },
    },
    {
      type: 'started',
      id: 'x',
      kind: 'shell',
      tool: 'run_terminal_command',
      description: 'rm -rf',
    },
    {
      type: 'completed',
      id: 'x',
      kind: 'shell',
      outcome: 'refused',
      error: true,
      row: {
        tool: 'run_terminal_command',
        input: undefined,
        output: 'Denied by permission policy',
        error: true,
      },
    },
  ]);
  assert.match(actions.text(), /Changed: a\.ts\.\n.*Not completed: rm -rf \(refused\)/s);
});

/** Supplies the admitted context a real session would; the gateway path is unchanged. */
function admitted(harness: NativeHarness): NativeHarness {
  return {
    validate: (body) => harness.validate(body),
    handle: (body, scope, signal, emit, _context, observe) =>
      harness.handle(body, scope, signal, emit, context, observe),
    recordedResponse: async (scope) => harness.recordedResponse?.(scope, context),
  };
}

async function gateway(t: test.TestContext, options: Parameters<typeof createNativeGateway>[0]) {
  const server = createNativeGateway(options);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'x-multi-gateway-token': 'progress-token' };
  const post = (route: string, body: unknown) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    send: (
      model: string,
      agent: string,
      messages: unknown = [{ role: 'user', content: 'work' }],
      session = 'progress-session',
    ) =>
      fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          ...headers,
          'x-claude-code-session-id': session,
          'x-claude-code-agent-id': agent,
        },
        body: JSON.stringify({ model, messages }),
      }),
    status: async (agent: string) =>
      (await fetch(`${base}/multi/mod/lifecycle?sessionId=progress-session&agentId=${agent}`, {
        headers,
      }).then((response) => response.json())) as Record<string, unknown>,
    /** What the mod does at session start: read the catalog, register, acknowledge. */
    register: async () => {
      const catalog = (await fetch(`${base}/multi/mod/display-tools`, { headers }).then(
        (response) => response.json(),
      )) as { names: string[] };
      await post('/multi/mod/display-tools', {
        sessionId: 'progress-session',
        registered: catalog.names,
      });
      return catalog.names;
    },
    verify: (token: unknown, toolUseId: unknown, sessionId = 'progress-session') =>
      post('/multi/mod/display', { sessionId, token, toolUseId }),
  };
}

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function until(condition: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function rowsOf(response: MessagesResponse) {
  return response.content.flatMap((block) => (block.type === 'tool_use' ? [block] : []));
}

test('an Antigravity worker writes each finished step as a native-named row and answers the follow-up', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-progress-'));
  t.after(() => removeTemporary(stateDirectory));
  const release = gate();
  let runs = 0;
  const harness = new AntigravityHarness([agyModel], {
    stateDirectory,
    checkPermissions: async () => ({ denied: [], plan: false, notice: 'Native policy' }),
    run: async (options: AntigravityRunOptions) => {
      runs++;
      options.onEvent?.({
        event: 'init',
        conversation_id: 'c1',
        init: { tools: ['write_to_file'] },
      });
      options.onEvent?.({
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'ACTIVE',
          tool_name: 'write_to_file',
          tool_info: { name: 'write_to_file', parameters: { TargetFile: 'a.ts' } },
        },
      });
      await release.opened;
      options.onEvent?.({
        event: 'step_update',
        step_update: {
          step_index: 1,
          tool_name: 'write_to_file',
          state: 'DONE',
          tool_info: { parameters: { TargetFile: 'a.ts' }, output: 'Created a.ts' },
        },
      });
      options.onEvent?.({
        event: 'step_update',
        step_update: {
          step_index: 2,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'written',
          usage: { input_tokens: 900, output_tokens: 3, cache_read_tokens: 100 },
        },
      });
      return {
        result: { conversation_id: 'c1', status: 'SUCCESS' as const, response: 'written' },
        exitCode: 0,
        signal: null,
        stderr: '',
      };
    },
  });
  t.after(() => harness.close());
  const { send, status, register, verify } = await gateway(t, {
    token: 'progress-token',
    authFile: 'unused',
    modBridge: new ModBridge(),
    displayRows: new DisplayRows(),
    displayTools: { antigravity: ANTIGRAVITY_TOOLS },
    antigravity: admitted(harness),
  });
  assert.deepEqual(await register(), [...ANTIGRAVITY_TOOLS]);
  const pending = send(agyModel.model, 'agy-worker');
  await until(
    async () => (await status('agy-worker')).detail === 'write_to_file: a.ts',
    'the running Antigravity action',
  );
  assert.equal((await status('agy-worker')).state, 'running');
  assert.deepEqual(await status('main'), {});
  release.open();
  const response = (await (await pending).json()) as MessagesResponse;
  const [row] = rowsOf(response);
  assert.equal(row?.name, 'mcp__multi-core__write_to_file');
  const input = row?.input as Record<string, unknown>;
  assert.equal(input.kind, 'Write');
  assert.equal(input.file_path, 'a.ts');
  assert.equal((input.native as Record<string, unknown>).TargetFile, 'a.ts');
  assert.deepEqual(await (await verify(input[ROW_TOKEN], row?.id)).json(), {
    output: 'Created a.ts',
    isError: false,
  });
  assert.equal((await verify('forged', row?.id)).status, 403);
  assert.equal((await verify(input[ROW_TOKEN], 'toolu_other')).status, 403);
  assert.equal((await verify(input[ROW_TOKEN], row?.id, 'other-session')).status, 403);
  // Text after the row is the turn's final message, which the follow-up carries.
  assert.match(
    response.multi_followup ?? '',
    /^written[\s\S]*\n\n\[Antigravity\] 1 native action: 1 edit; 1 model call\.\n\[Antigravity\] Changed: a\.ts\.\n$/,
  );
  assert.equal((await status('agy-worker')).state, 'completed');

  const followUp = await send(agyModel.model, 'agy-worker', [
    { role: 'user', content: 'work' },
    { role: 'assistant', content: response.content },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: row?.id,
          content: [{ type: 'text', text: 'Created a.ts' }],
        },
      ],
    },
  ]);
  const answered = (await followUp.json()) as MessagesResponse;
  assert.deepEqual(answered.content, [{ type: 'text', text: response.multi_followup }]);
  // The follow-up is the turn's last response, so it keeps the reply's context.
  assert.deepEqual(response.usage, {
    input_tokens: 900,
    output_tokens: 3,
    cache_read_input_tokens: 100,
  });
  assert.deepEqual(answered.usage, {
    input_tokens: 900,
    output_tokens: 0,
    cache_read_input_tokens: 100,
  });
  assert.equal(runs, 1, 'the follow-up never starts a native run');
});

test('a Grok worker writes its native tool calls as rows under their native names', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'grok-progress-'));
  t.after(() => removeTemporary(stateDirectory));
  const harness = new GrokHarness([grokModel], {
    stateDirectory,
    checkPermissions: async (_cwd, value) => grokPermissionPolicy(value),
    run: async (options: GrokRunOptions) => {
      options.onEvent?.({
        event: 'tool_call',
        call: {
          toolCallId: 't1',
          toolName: 'read_file',
          kind: 'read',
          title: 'Read README.md',
          status: 'pending',
          rawInput: { path: 'README.md' },
        },
      });
      options.onEvent?.({
        event: 'tool_update',
        call: { toolCallId: 't1', status: 'completed', rawOutput: '# Multi' },
      });
      options.onEvent?.({ event: 'text', text: 'read it' });
      return {
        result: {
          sessionId: options.resume ?? options.session ?? 'unknown',
          stopReason: 'end_turn',
        },
        response: 'read it',
        exitCode: 0,
        signal: null,
        stderr: '',
      };
    },
  });
  t.after(() => harness.close());
  const { send, status, register, verify } = await gateway(t, {
    token: 'progress-token',
    authFile: 'unused',
    modBridge: new ModBridge(),
    displayTools: { grok: GROK_TOOLS, cursor: ['unused_without_cursor'] },
    grok: admitted(harness),
  });
  const names = await register();
  assert.ok(names.includes('read_file'));
  assert.ok(!names.includes('unused_without_cursor'), 'only running harnesses offer rows');
  const response = (await (await send(grokModel.model, 'grok-worker')).json()) as MessagesResponse;
  const [row] = rowsOf(response);
  assert.equal(row?.name, 'mcp__multi-core__read_file');
  const input = row?.input as Record<string, unknown>;
  assert.equal(input.kind, 'Read');
  assert.equal(input.file_path, 'README.md');
  assert.equal((input.native as Record<string, unknown>).path, 'README.md');
  assert.deepEqual(await (await verify(input[ROW_TOKEN], row?.id)).json(), {
    output: '# Multi',
    isError: false,
  });
  assert.match(response.multi_followup ?? '', /^read it\n\n\[Grok\] 1 native action: 1 read\./);
  assert.equal((await status('grok-worker')).state, 'completed');
});

test('without the mod registering display tools, a run writes no rows', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'grok-unregistered-'));
  t.after(() => removeTemporary(stateDirectory));
  const harness = new GrokHarness([grokModel], {
    stateDirectory,
    checkPermissions: async (_cwd, value) => grokPermissionPolicy(value),
    run: async (options: GrokRunOptions) => {
      options.onEvent?.({
        event: 'tool_call',
        call: { toolCallId: 't1', toolName: 'read_file', kind: 'read', status: 'completed' },
      });
      return {
        result: { sessionId: options.session ?? 'unknown', stopReason: 'end_turn' },
        response: 'done',
        exitCode: 0,
        signal: null,
        stderr: '',
      };
    },
  });
  t.after(() => harness.close());
  const { send } = await gateway(t, {
    token: 'progress-token',
    authFile: 'unused',
    displayTools: { grok: GROK_TOOLS },
    grok: admitted(harness),
  });
  const response = (await (await send(grokModel.model, 'grok-worker')).json()) as MessagesResponse;
  assert.deepEqual(rowsOf(response), []);
  assert.equal(response.multi_followup, undefined);
  assert.match(JSON.stringify(response.content), /\[Grok\] 1 native action: 1 read\./);
});

test('a refused harness request reaches the status route with exactly the reason it was refused for', async (t) => {
  const bridge = new ModBridge();
  let calls = 0;
  const { send, status } = await gateway(t, {
    token: 'progress-token',
    authFile: 'unused',
    modBridge: bridge,
    permissionModes: new PermissionModes(async () => ({})),
    antigravity: {
      validate: () => 1,
      handle: async () => {
        calls++;
        throw new Error('unreachable');
      },
    },
  });
  const refused = await send(agyModel.model, 'agy-worker');
  assert.equal(refused.status, 400);
  const answer = (await refused.json()) as { error: { message: string } };
  const body = await status('agy-worker');
  assert.equal(calls, 0);
  assert.equal(body.state, 'failed');
  // The status carries the whole reason the request was refused with, as one line.
  assert.equal(`Native gateway: ${body.error}`, answer.error.message);
  assert.ok(typeof body.error === 'string' && body.error.length > 40 && body.error.length <= 240);
});

test('failure reasons are one terminal-safe line and never replace a running run', () => {
  const bridge = new ModBridge();
  const key = JSON.stringify(['s', 'w']);
  const escapeCharacter = String.fromCharCode(27);
  bridge.refuse(
    key,
    'multi/grok/grok-4.6',
    `${escapeCharacter}[31mdenied${escapeCharacter}[0m\n  twice`,
  );
  assert.equal(bridge.status(key)?.error, 'denied twice');
  assert.equal(bridge.status(key)?.state, 'failed');
  const run = bridge.begin(key, 'multi/grok/grok-4.6');
  assert.equal(bridge.status(key)?.error, undefined);
  bridge.refuse(key, 'multi/grok/grok-4.6', 'conflict');
  assert.equal(bridge.status(key)?.state, 'running');
  bridge.complete(key, 'failed', run, `spawn refused: ${'x'.repeat(400)}`);
  assert.equal(bridge.status(key)?.error?.length, 240);
  assert.match(bridge.status(key)?.error ?? '', /^spawn refused: x+$/);
});

/** An Antigravity harness whose every run writes one file, so its reply carries one row. */
function writingHarness(stateDirectory: string, counter: { runs: number }) {
  return new AntigravityHarness([agyModel], {
    stateDirectory,
    checkPermissions: async () => ({ denied: [], plan: false, notice: 'Native policy' }),
    run: async (options: AntigravityRunOptions) => {
      counter.runs++;
      options.onEvent?.({
        event: 'init',
        conversation_id: 'c1',
        init: { tools: ['write_to_file'] },
      });
      options.onEvent?.({
        event: 'step_update',
        step_update: {
          step_index: 1,
          tool_name: 'write_to_file',
          state: 'DONE',
          tool_info: { parameters: { TargetFile: 'a.ts' }, output: 'Created a.ts' },
        },
      });
      options.onEvent?.({
        event: 'step_update',
        step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'A' },
      });
      return {
        result: { conversation_id: 'c1', status: 'SUCCESS' as const, response: 'A' },
        exitCode: 0,
        signal: null,
        stderr: '',
      };
    },
  });
}

/** The engine's next request after running a reply's rows: only their results. */
function rowResults(response: MessagesResponse) {
  return [
    { role: 'user', content: 'work' },
    { role: 'assistant', content: response.content },
    {
      role: 'user',
      content: rowsOf(response).map((row) => ({
        type: 'tool_result',
        tool_use_id: row.id,
        content: [{ type: 'text', text: 'Created a.ts' }],
      })),
    },
  ];
}

async function failure(response: Response) {
  const body = (await response.json()) as { error?: { message?: string } };
  return { status: response.status, message: body.error?.message ?? '' };
}

test('a follow-up is answered only to the session and worker whose reply wrote the rows', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-followup-scope-'));
  t.after(() => removeTemporary(stateDirectory));
  const counter = { runs: 0 };
  const harness = writingHarness(stateDirectory, counter);
  t.after(() => harness.close());
  const { send, register } = await gateway(t, {
    token: 'progress-token',
    authFile: 'unused',
    modBridge: new ModBridge(),
    displayRows: new DisplayRows(),
    displayTools: { antigravity: ANTIGRAVITY_TOOLS },
    antigravity: admitted(harness),
  });
  await register();
  const answer = (await (
    await send(agyModel.model, 'agy-worker', undefined, 'session-a')
  ).json()) as MessagesResponse;
  assert.equal(rowsOf(answer).length, 1);
  assert.match(answer.multi_followup ?? '', /^A/);

  // Another session carrying session A's row ids gets a refusal, never A's answer.
  const stolen = await failure(
    await send(agyModel.model, 'agy-worker', rowResults(answer), 'session-b'),
  );
  assert.equal(stolen.status, 403);
  assert.match(stolen.message, /another session or worker/);
  assert.doesNotMatch(stolen.message, /\bA\b/);
  // Another worker of the same session is refused the same way.
  const sibling = await failure(
    await send(agyModel.model, 'other-worker', rowResults(answer), 'session-a'),
  );
  assert.equal(sibling.status, 403);

  // The owner still receives its answer, and a retry in its own scope is answered again.
  for (let attempt = 0; attempt < 2; attempt++) {
    const owned = (await (
      await send(agyModel.model, 'agy-worker', rowResults(answer), 'session-a')
    ).json()) as MessagesResponse;
    assert.deepEqual(owned.content, [{ type: 'text', text: answer.multi_followup }]);
  }
  assert.equal(counter.runs, 1, 'no follow-up starts a native run');
});

test('the display rows forget the follow-ups of a session when it ends', () => {
  const rows = new DisplayRows();
  const owner = { scope: JSON.stringify(['s1', 'main']), provider: 'antigravity' };
  const other = { scope: JSON.stringify(['s2', 'main']), provider: 'antigravity' };
  rows.rememberFollowUp(owner, { id: 'msg_1', rows: ['toolu_a'], text: 'answer' });
  rows.rememberFollowUp(other, { id: 'msg_2', rows: ['toolu_b'], text: 'other' });
  assert.equal(rows.followUp(owner, ['toolu_a'])?.text, 'answer');
  assert.throws(() => rows.followUp(other, ['toolu_a']), /another session or worker/);
  assert.throws(
    () => rows.followUp({ ...owner, provider: 'grok' }, ['toolu_a']),
    /another session or worker/,
  );
  rows.forgetSession('s1');
  assert.equal(rows.followUp(owner, ['toolu_a']), undefined);
  assert.equal(rows.followUp(other, ['toolu_b'])?.text, 'other');
});

test('a follow-up is recovered from the harness record after a restart, and fails explicitly without one', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-followup-restart-'));
  t.after(() => removeTemporary(stateDirectory));
  const counter = { runs: 0 };
  const first = writingHarness(stateDirectory, counter);
  const before = await gateway(t, {
    token: 'progress-token',
    authFile: 'unused',
    displayRows: new DisplayRows(),
    displayTools: { antigravity: ANTIGRAVITY_TOOLS },
    antigravity: admitted(first),
  });
  await before.register();
  const answer = (await (
    await before.send(agyModel.model, 'agy-worker', undefined, 'session-a')
  ).json()) as MessagesResponse;
  assert.equal(rowsOf(answer).length, 1);
  await first.close();

  // A restarted gateway: new display rows, a new harness over the same records.
  const second = writingHarness(stateDirectory, counter);
  t.after(() => second.close());
  const after = await gateway(t, {
    token: 'progress-token',
    authFile: 'unused',
    displayRows: new DisplayRows(),
    displayTools: { antigravity: ANTIGRAVITY_TOOLS },
    antigravity: admitted(second),
  });
  const recovered = await after.send(agyModel.model, 'agy-worker', rowResults(answer), 'session-a');
  assert.equal(recovered.status, 200);
  const recoveredBody = (await recovered.json()) as MessagesResponse;
  assert.deepEqual(recoveredBody.content, [{ type: 'text', text: answer.multi_followup }]);
  // The record binds the answer to its scope: another session still gets nothing.
  const stolen = await failure(
    await after.send(agyModel.model, 'agy-worker', rowResults(answer), 'session-b'),
  );
  assert.equal(stolen.status, 404);
  assert.match(stolen.message, /no longer available/);

  // Rows no record holds are an explicit error, not a silent "Native run finished.".
  const forged = rowResults(answer).map((message) =>
    JSON.parse(
      JSON.stringify(message).replaceAll(
        rowsOf(answer)[0]?.id ?? '',
        `toolu_multi_${'f'.repeat(32)}`,
      ),
    ),
  );
  const missing = await failure(
    await after.send(agyModel.model, 'agy-worker', forged, 'session-a'),
  );
  assert.equal(missing.status, 404);
  assert.match(missing.message, /no longer available/);
  assert.equal(counter.runs, 1, 'recovery never reruns the native turn');
});

test('an action whose completion never arrives is unconfirmed: no success row, not listed as changed', () => {
  const { seen, rows, actions } = tracker();
  actions.start('e', {
    ...action('edit', 'write_to_file', 'write_to_file: a.ts'),
    changed: 'a.ts',
  });
  actions.start('r', action('read', 'view_file', 'view_file: b.ts'));
  actions.finish('r', { outcome: 'done', error: false });
  const summary = actions.text();
  const settled = seen.find((item) => item.type === 'completed' && item.id === 'e');
  assert.ok(settled?.type === 'completed');
  assert.equal(settled.error, false);
  assert.equal(settled.unconfirmed, true);
  assert.equal(settled.row.unconfirmed, true);
  assert.deepEqual(rows, ['row-r', 'row-e']);
  assert.doesNotMatch(summary, /Changed/);
  assert.match(summary, /\[Native\] 2 native actions: 1 read, 1 edit\.\n/);
  assert.match(summary, /\[Native\] Unconfirmed: 1 action ended without a reported outcome\.\n/);
});

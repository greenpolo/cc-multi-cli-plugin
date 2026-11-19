import type { On as EngineOn } from 'claude-code';
import type { Engine as TestEngine } from 'claude-code/testing';
import { expect, mock, test } from 'claude-code/testing';

type On = EngineOn;
type Engine = TestEngine;

const surfaces = ['terminal', 'desktop'] as const;

/** A gateway that resolves every Cursor and Antigravity id it is given. */
function gateway(on: On) {
  on('env.get', (_$, event) => ({
    value: event.name === 'MULTI_GATEWAY_TOKEN' ? 'token' : 'http://127.0.0.1:4000',
  }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('http.fetch', (_$, event) => {
    const body = event.init?.body
      ? (JSON.parse(String(event.init.body)) as Record<string, unknown>)
      : {};
    const reply = (value: unknown) => ({
      value: { ok: true, status: 200, headers: {}, text: JSON.stringify(value) },
    });
    if (event.url.endsWith('/multi/mod/worker-model')) {
      const provider = String(body.subagentType).toLowerCase();
      return reply({ known: true, execution: 'harness', model: `multi/${provider}/${body.model}` });
    }
    if (event.url.includes('/multi/mod/mode?')) {
      return reply({ generation: 1 });
    }
    return reply({ accepted: true });
  });
  on('agent.spawn', (_$, event) => ({ model: event.model ?? 'unset', agentId: 'agent-cursor' }));
}

/** The engine beneath the mod: the props it was asked to draw. */
function engine(on: On) {
  const drawn: Array<Record<string, unknown>> = [];
  on('ui.render', (_$, event) => {
    drawn.push(event.props as Record<string, unknown>);
    return { type: 'engine', ref: 0 } as never;
  });
  return drawn;
}

async function agentRow(
  $: Engine,
  surface: (typeof surfaces)[number],
  props: Record<string, unknown>,
) {
  const row = await $.ui.mount({
    plugin: 'multi-core',
    surface,
    component: 'ToolUse',
    requestId: String(props.tool_use_id),
    props: {
      tool: 'Agent',
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      ...props,
    } as never,
  });
  await row.drawn();
  return row;
}

async function notification(
  $: Engine,
  surface: (typeof surfaces)[number],
  props: Record<string, unknown>,
) {
  const row = await $.ui.mount({
    plugin: 'multi-core',
    surface,
    component: 'UserMessage',
    requestId: 'message',
    props: {
      text: 'Agent "Fix tests" completed',
      origin: { kind: 'task-notification' },
      isExpanded: false,
      ...props,
    } as never,
  });
  await row.drawn();
  await row.unmount();
}

const input = {
  description: 'Fix tests',
  prompt: 'task',
  subagent_type: 'Cursor',
  model: 'composer-2.5',
};

test('a running provider worker row shows its provider and resolved model', async ($, on) => {
  mock.clock(on);
  gateway(on);
  const drawn = engine(on);
  await $.agent.spawn({
    prompt: 'task',
    subagentType: 'Cursor',
    model: 'composer-2.5',
    tool_use_id: 'toolu_cursor',
  } as never);
  for (const surface of surfaces) {
    // Compact: the engine's own row, named for the CLI, the model beside the task.
    const row = await agentRow($, surface, {
      tool_use_id: 'toolu_cursor',
      input,
      isRunning: true,
    });
    await row.unmount();
    const compact = drawn.at(-1) as { tool: string; input: Record<string, unknown> };
    expect(compact.tool).toBe('Cursor');
    expect(compact.input.description).toBe('Fix tests · composer-2.5');
    expect(compact.input.model).toBeUndefined();
    // ctrl+o names it the same way.
    const full = await agentRow($, surface, {
      tool_use_id: 'toolu_cursor',
      input,
      isRunning: true,
      isExpanded: true,
    });
    await full.unmount();
    const props = drawn.at(-1) as { tool: string; input: Record<string, unknown> };
    expect(props.tool).toBe('Cursor');
    expect(props.input.description).toBe('Fix tests · composer-2.5');
    // The rest of the call's input is drawn as sent, less the provider model the Agent
    // schema rejects (the engine draws a rejected input as a bare `Agent`).
    expect(props.input.subagent_type).toBe('Cursor');
    expect(props.input.prompt).toBe('task');
    expect(props.input.model).toBeUndefined();
  }
});

test('a completed worker row reads the model from its result after a reload', async ($, on) => {
  mock.clock(on);
  gateway(on);
  const drawn = engine(on);
  for (const surface of surfaces) {
    const row = await agentRow($, surface, {
      tool_use_id: 'toolu_restored',
      input: { ...input, description: 'Review', subagent_type: 'Antigravity' },
      output: { status: 'completed', resolvedModel: 'multi/antigravity/gemini-3.8-flash[1m]' },
    });
    await row.unmount();
    const compact = drawn.at(-1) as { tool: string; input: Record<string, unknown> };
    expect(compact.tool).toBe('Antigravity');
    expect(compact.input.description).toBe('Review · gemini-3.8-flash');
  }
});

test('Claude agents and other tools keep their rows unlabelled', async ($, on) => {
  mock.clock(on);
  gateway(on);
  const drawn = engine(on);
  await (
    await agentRow($, 'terminal', {
      tool_use_id: 'toolu_explore',
      input: { description: 'Look', prompt: 'task', subagent_type: 'Explore' },
      output: { status: 'completed', resolvedModel: 'claude-haiku-4-5' },
    })
  ).unmount();
  expect((drawn.at(-1) as { input: { description: string } }).input.description).toBe('Look');
  await (
    await agentRow($, 'terminal', {
      tool: 'Read',
      tool_use_id: 'toolu_read',
      input: { file_path: '/workspace/a' },
    })
  ).unmount();
  expect((drawn.at(-1) as { input: Record<string, unknown> }).input).toEqual({
    file_path: '/workspace/a',
  });
});

test('a worker notification keeps the engine’s own words', async ($, on) => {
  mock.clock(on);
  gateway(on);
  const drawn = engine(on);
  await $.agent.spawn({
    prompt: 'task',
    description: 'Fix tests',
    subagentType: 'Cursor',
    model: 'composer-2.5',
    tool_use_id: 'toolu_cursor',
  } as never);
  await notification($, 'terminal', { task: { id: 'agent-cursor', status: 'completed' } });
  expect(drawn.at(-1)?.text).toBe('Agent "Fix tests" completed');
});

test("turn.step leaves an Agent call's streamed input exactly as the model wrote it", async ($, on) => {
  mock.clock(on);
  gateway(on);
  const written = JSON.stringify({
    description: 'Fix tests',
    prompt: 'task 1',
    subagent_type: 'Cursor',
    model: 'composer-2.5',
  });
  on('turn.step', async function* (_$, event) {
    yield { kind: 'tool', index: 1, id: 'toolu_cursor', name: 'Agent' };
    // Partial JSON, as a stream delivers it: nothing parses or rewrites it.
    yield { kind: 'input', index: 1, json: written.slice(0, 20) };
    yield { kind: 'input', index: 1, json: written.slice(20) };
    return {
      turnId: event.turnId,
      index: event.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });
  const json: string[] = [];
  for await (const chunk of $.turn.step({
    turnId: 't1',
    index: 0,
    model: 'claude-sonnet-5',
    messageCount: 1,
  })) {
    if (chunk.kind === 'input') {
      json.push(chunk.json);
    }
  }
  expect(json.join('')).toBe(written);
});

async function listRow($: Engine, props: Record<string, unknown>) {
  const row = await $.ui.mount({
    plugin: 'multi-core',
    surface: 'terminal',
    component: 'AgentRow',
    requestId: 'agent-grok',
    props: {
      id: 'agent-grok',
      description: 'Port the reader',
      type: 'Grok',
      status: 'running',
      kind: 'local_agent',
      taskStatus: 'running',
      label: 'Port the reader',
      startTime: 0,
      cwd: '/workspace',
      model: 'multi/grok/grok-build',
      tokenCount: 925,
      tokenSamples: [],
      hasRow: true,
      rowIds: ['agent-grok'],
      columns: 60,
      isHidden: false,
      ...props,
    } as never,
  });
  await row.drawn();
  await row.unmount();
}

const plain = (text: unknown) =>
  String(text).replaceAll('\u001b[2m', '').replaceAll('\u001b[22m', '');

test('the agent list names a worker for its CLI, keeps its task and adds its newest action', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, { MULTI_GATEWAY_TOKEN: 'token', MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000' });
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: 'C:\\Users\\lab\\repo' }));
  on('ui.status', () => ({ value: undefined }));
  // A call on `$` is answered as `{ value }`, which the event's result type does not name.
  on(
    'agent.list',
    () =>
      ({
        value: [
          { id: 'agent-grok', type: 'Grok', model: 'multi/grok/grok-build', hasRow: true },
          { id: 'agent-x', type: 'Explore', model: 'claude-haiku-4-5', hasRow: true },
        ],
      }) as never,
  );
  on('http.fetch', (_$, event) => {
    const reply = (value: unknown) => ({
      value: { ok: true, status: 200, headers: {}, text: JSON.stringify(value) },
    });
    if (event.url.includes('/multi/mod/lifecycle')) {
      return reply({
        model: 'multi/grok/grok-build',
        state: 'running',
        detail: 'read_file: C:\\Users\\lab\\repo\\src\\reader.ts',
        elapsedMs: 3000,
        startedAt: Number.MAX_SAFE_INTEGER,
      });
    }
    return reply({ revision: 1, names: [], accepted: true });
  });
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text', index: 0, text: 'done' };
    return {
      turnId: event.turnId,
      index: 0,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: null,
    };
  });
  const drawn = engine(on);
  await clock.set(13_000);
  // The name column is padded to the longest listed name, as the engine pads it; a
  // harness run's token count would sit still, so only its time shows.
  await listRow($, {});
  expect(plain(drawn.at(-1)?.body)).toBe(`Grok     Port the reader${' '.repeat(33)}13s`);
  for await (const _chunk of $.turn.step({
    turnId: 't',
    index: 0,
    model: 'multi/grok/grok-build',
    messageCount: 1,
    agentId: 'agent-grok',
  })) {
    // The worker's run is under way once its step began.
  }
  await clock.advance(500);
  await listRow($, {});
  expect(plain(drawn.at(-1)?.body)).toBe(
    `Grok     Port the reader  read_file: src/reader.ts${' '.repeat(7)}13s`,
  );
  // A finished worker shows its task alone.
  await listRow($, { taskStatus: 'completed', status: 'completed' });
  expect(plain(drawn.at(-1)?.body)).toBe(`Grok     Port the reader${' '.repeat(33)}13s`);
  // An OpenAI worker runs Claude's own loop, so its tokens are counted.
  await listRow($, { type: 'OpenAI', model: 'multi/openai/gpt-6-luna', tokenCount: 6800 });
  expect(plain(drawn.at(-1)?.body)).toContain('OpenAI   Port the reader');
  expect(plain(drawn.at(-1)?.body)).toMatch(/13s · ↓ 6\.8k tokens$/);
  // A Claude agent is the engine's row.
  await listRow($, { type: 'Explore', model: 'claude-haiku-4-5' });
  expect(drawn.at(-1)?.body).toBeUndefined();
});

test('the spinner names the CLI and its current step while it is the main model', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, { MULTI_GATEWAY_TOKEN: 'token', MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000' });
  on('session.id', () => ({ value: 's' }));
  on('ui.status', () => ({ value: undefined }));
  on('http.fetch', (_$, event) => {
    const reply = (value: unknown) => ({
      value: { ok: true, status: 200, headers: {}, text: JSON.stringify(value) },
    });
    if (event.url.includes('/multi/mod/lifecycle')) {
      return reply({
        model: 'multi/cursor/auto',
        state: 'running',
        detail: 'edit: src/x.ts',
        elapsedMs: 3000,
        startedAt: Number.MAX_SAFE_INTEGER,
      });
    }
    return reply({ revision: 1, names: [], accepted: true });
  });
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text', index: 0, text: 'done' };
    return {
      turnId: event.turnId,
      index: 0,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: null,
    };
  });
  const drawn = engine(on);
  const spin = async () => {
    const row = await $.ui.mount({
      plugin: 'multi-core',
      surface: 'terminal',
      component: 'Spinner',
      requestId: 'spinner',
      props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' },
    });
    await row.drawn();
    await row.unmount();
    return drawn.at(-1)?.word;
  };
  expect(await spin()).toBe('Sauteing');
  for await (const _chunk of $.turn.step({
    turnId: 't',
    index: 0,
    model: 'multi/cursor/auto',
    messageCount: 1,
  })) {
    // The run is under way once its step began.
  }
  expect(await spin()).toBe('Cursor');
  await clock.advance(500);
  expect(await spin()).toBe('Cursor · edit: src/x.ts');
});

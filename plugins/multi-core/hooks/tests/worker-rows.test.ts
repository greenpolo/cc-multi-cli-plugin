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
      const provider = String(body.subagentType).replace('multi-', '');
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
  await row.unmount();
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
  subagent_type: 'multi-cursor',
  model: 'composer-2.5',
};

test('a running provider worker row shows its provider and resolved model', async ($, on) => {
  mock.clock(on);
  gateway(on);
  const drawn = engine(on);
  await $.agent.spawn({
    prompt: 'task',
    subagentType: 'multi-cursor',
    model: 'composer-2.5',
    tool_use_id: 'toolu_cursor',
  } as never);
  for (const surface of surfaces) {
    await agentRow($, surface, { tool_use_id: 'toolu_cursor', input, isRunning: true });
    const props = drawn.at(-1) as { input: Record<string, unknown> };
    expect(props.input.description).toBe('Fix tests · Cursor · composer-2.5');
    // The rest of the call's input is drawn as sent, less the provider model the Agent
    // schema rejects (the engine draws a rejected input as a bare `Agent`).
    expect(props.input.subagent_type).toBe('multi-cursor');
    expect(props.input.prompt).toBe('task');
    expect(props.input.model).toBeUndefined();
  }
});

test('a completed worker row reads the model from its result after a reload', async ($, on) => {
  mock.clock(on);
  gateway(on);
  const drawn = engine(on);
  for (const surface of surfaces) {
    await agentRow($, surface, {
      tool_use_id: 'toolu_restored',
      input: { ...input, description: 'Review', subagent_type: 'multi-antigravity' },
      output: { status: 'completed', resolvedModel: 'multi/antigravity/gemini-3.8-flash[1m]' },
    });
    const props = drawn.at(-1) as { input: Record<string, unknown> };
    expect(props.input.description).toBe('Review · Antigravity · gemini-3.8-flash');
  }
});

test('Claude agents and other tools keep their rows unlabelled', async ($, on) => {
  mock.clock(on);
  gateway(on);
  const drawn = engine(on);
  await agentRow($, 'terminal', {
    tool_use_id: 'toolu_explore',
    input: { description: 'Look', prompt: 'task', subagent_type: 'Explore' },
    output: { status: 'completed', resolvedModel: 'claude-haiku-4-5' },
  });
  expect((drawn.at(-1) as { input: { description: string } }).input.description).toBe('Look');
  await agentRow($, 'terminal', {
    tool: 'Read',
    tool_use_id: 'toolu_read',
    input: { file_path: '/workspace/a' },
  });
  expect((drawn.at(-1) as { input: Record<string, unknown> }).input).toEqual({
    file_path: '/workspace/a',
  });
});

test('a worker notification shows its provider and model, and ctrl+o keeps the full row', async ($, on) => {
  mock.clock(on);
  gateway(on);
  const drawn = engine(on);
  await $.agent.spawn({
    prompt: 'task',
    subagentType: 'multi-cursor',
    model: 'composer-2.5',
    tool_use_id: 'toolu_cursor',
  } as never);
  for (const surface of surfaces) {
    await notification($, surface, { task: { id: 'agent-cursor', status: 'completed' } });
    expect(drawn.at(-1)?.text).toBe('Agent "Fix tests" completed · Cursor · composer-2.5');
    // A notification that names only its call still finds the spawn.
    await notification($, surface, { task: { toolUseId: 'toolu_cursor', status: 'failed' } });
    expect(drawn.at(-1)?.text).toBe('Agent "Fix tests" completed · Cursor · composer-2.5');
    await notification($, surface, {
      isExpanded: true,
      task: { id: 'agent-cursor', status: 'completed' },
    });
    expect(drawn.at(-1)?.text).toBe('Agent "Fix tests" completed');
    await notification($, surface, { task: { id: 'shell-1', status: 'completed' } });
    expect(drawn.at(-1)?.text).toBe('Agent "Fix tests" completed');
    // A summary that already names the model (the spawn labels its description) is kept.
    const summary = 'Agent "Fix tests · Cursor · composer-2.5" finished';
    await notification($, surface, { text: summary, task: { id: 'agent-cursor' } });
    expect(drawn.at(-1)?.text).toBe(summary);
  }
});

test("turn.step leaves an Agent call's streamed input exactly as the model wrote it", async ($, on) => {
  mock.clock(on);
  gateway(on);
  const written = JSON.stringify({
    description: 'Fix tests',
    prompt: 'task 1',
    subagent_type: 'multi-cursor',
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

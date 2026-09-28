import { expect, test } from 'claude-code/testing';

type On = Parameters<Parameters<typeof test>[1]>[1];
type Engine = Parameters<Parameters<typeof test>[1]>[0];

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

test('turn.step rewrites complete Agent tool inputs with provider and model while preserving other chunks', async ($, on) => {
  gateway(on);
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text', index: 0, text: 'launching workers' };
    yield { kind: 'tool', index: 1, id: 'toolu_cursor', name: 'Agent' };
    yield {
      kind: 'input',
      index: 1,
      json: JSON.stringify({
        description: 'Fix tests',
        prompt: 'task 1',
        subagent_type: 'multi-cursor',
        model: 'composer-2.5',
      }),
    };
    yield { kind: 'tool', index: 2, id: 'toolu_agy', name: 'Agent' };
    yield {
      kind: 'input',
      index: 2,
      json: JSON.stringify({
        description: 'Review code',
        prompt: 'task 2',
        subagent_type: 'multi-antigravity',
        model: 'gemini-3.8-flash[1m]',
      }),
    };
    yield { kind: 'tool', index: 3, id: 'toolu_builtin', name: 'Agent' };
    yield {
      kind: 'input',
      index: 3,
      json: JSON.stringify({
        description: 'Search repo',
        prompt: 'search',
        subagent_type: 'Explore',
      }),
    };
    yield { kind: 'tool', index: 4, id: 'toolu_read', name: 'Read' };
    yield {
      kind: 'input',
      index: 4,
      json: JSON.stringify({
        file_path: '/workspace/src/index.ts',
      }),
    };
    yield { kind: 'input', index: 1, json: '{"partial' };
    return {
      turnId: event.turnId,
      index: event.index,
      answer: 'launching workers',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });

  const chunks: Array<Record<string, unknown>> = [];
  for await (const chunk of $.turn.step({
    turnId: 't1',
    index: 0,
    model: 'claude-sonnet-5',
    messageCount: 1,
  })) {
    chunks.push(chunk as Record<string, unknown>);
  }

  expect(chunks[0]).toEqual({ kind: 'text', index: 0, text: 'launching workers' });
  expect(chunks[1]).toEqual({ kind: 'tool', index: 1, id: 'toolu_cursor', name: 'Agent' });

  const cursorInput = JSON.parse(String(chunks[2]?.json)) as Record<string, unknown>;
  expect(cursorInput.description).toBe('Fix tests · Cursor · composer-2.5');
  expect(cursorInput.prompt).toBe('task 1');
  expect(cursorInput.subagent_type).toBe('multi-cursor');
  expect(cursorInput.model).toBe('composer-2.5');

  expect(chunks[3]).toEqual({ kind: 'tool', index: 2, id: 'toolu_agy', name: 'Agent' });

  const agyInput = JSON.parse(String(chunks[4]?.json)) as Record<string, unknown>;
  expect(agyInput.description).toBe('Review code · Antigravity · gemini-3.8-flash');
  expect(agyInput.prompt).toBe('task 2');
  expect(agyInput.subagent_type).toBe('multi-antigravity');

  expect(chunks[5]).toEqual({ kind: 'tool', index: 3, id: 'toolu_builtin', name: 'Agent' });
  const exploreInput = JSON.parse(String(chunks[6]?.json)) as Record<string, unknown>;
  expect(exploreInput.description).toBe('Search repo');
  expect(exploreInput.prompt).toBe('search');

  expect(chunks[7]).toEqual({ kind: 'tool', index: 4, id: 'toolu_read', name: 'Read' });
  expect(JSON.parse(String(chunks[8]?.json))).toEqual({ file_path: '/workspace/src/index.ts' });

  expect(chunks[9]?.json).toBe('{"partial');
});

test('turn.step uses provider name only when the worker model is unresolvable', async ($, on) => {
  on('env.get', (_$, event) => ({
    value: event.name === 'MULTI_GATEWAY_TOKEN' ? 'token' : 'http://127.0.0.1:4000',
  }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('http.fetch', () => ({
    value: { ok: false, status: 503, headers: {}, text: 'Gateway unavailable' },
  }));
  on('turn.step', async function* (_$, event) {
    yield { kind: 'tool', index: 0, id: 'toolu_grok', name: 'Agent' };
    yield {
      kind: 'input',
      index: 0,
      json: JSON.stringify({
        description: 'Audit codebase',
        prompt: 'audit',
        subagent_type: 'multi-grok',
      }),
    };
    return {
      turnId: event.turnId,
      index: event.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });

  const chunks: Array<Record<string, unknown>> = [];
  for await (const chunk of $.turn.step({
    turnId: 't2',
    index: 0,
    model: 'claude-sonnet-5',
    messageCount: 1,
  })) {
    chunks.push(chunk as Record<string, unknown>);
  }

  const grokInput = JSON.parse(String(chunks[1]?.json)) as Record<string, unknown>;
  expect(grokInput.description).toBe('Audit codebase · Grok');
  expect(grokInput.prompt).toBe('audit');
});

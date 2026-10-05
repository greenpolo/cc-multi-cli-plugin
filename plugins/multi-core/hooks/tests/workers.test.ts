import type { On as EngineOn } from 'claude-code';
import type { Engine as TestEngine } from 'claude-code/testing';
import { expect, mock, test } from 'claude-code/testing';
import { register } from '../workers.ts';

test('registers the worker admission hook', () => {
  expect(typeof register).toBe('function');
});

test('agent.offer hides an unsupported worker before dispatch', async ($, on) => {
  mock.clock(on);
  on('env.get', (_$, event) => ({
    value: event.name === 'MULTI_GATEWAY_TOKEN' ? 'token' : 'http://127.0.0.1:4000',
  }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('session.model', () => ({ value: 'claude-sonnet-5' }));
  on('http.fetch', () => ({
    value: {
      ok: true,
      status: 200,
      headers: {},
      text: '{"execution":"harness","isOffered":false}',
    },
  }));
  on('agent.offer', () => ({ isOffered: true }));
  const result = await $.agent.offer({
    agent: 'unknown',
    description: 'unknown',
    source: 'plugin',
    provider: { plugin: 'engine', tier: 'core' },
  });
  expect(result.isOffered).toBe(false);
});

test('agent.offer preserves a known catalog worker', async ($, on) => {
  mock.clock(on);
  on('env.get', (_$, event) => ({
    value: event.name === 'MULTI_GATEWAY_TOKEN' ? 'token' : 'http://127.0.0.1:4000',
  }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('session.model', () => ({ value: 'claude-sonnet-5' }));
  on('http.fetch', () => ({
    value: { ok: true, status: 200, headers: {}, text: '{"execution":"claude","isOffered":false}' },
  }));
  on('agent.offer', () => ({ isOffered: true }));
  const result = await $.agent.offer({
    agent: 'cursor',
    description: 'known',
    source: 'plugin',
    provider: { plugin: 'engine', tier: 'core' },
  });
  expect(result.isOffered).toBe(true);
});

test('worker spawn is denied when gateway admission is unavailable', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: 'configured' }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('http.fetch', () => ({ value: { ok: false, status: 503, headers: {}, text: '{}' } }));
  let started = false;
  on('agent.spawn', () => {
    started = true;
    return { model: 'm', agentId: 'worker' };
  });
  const result = await $.agent.spawn({
    prompt: 'task',
    subagentType: 'cursor',
    model: 'multi/cursor/auto',
  } as never);
  expect(typeof result.deny).toBe('string');
  expect(started).toBe(false);
});

test('harness spawn remains dormant when gateway is not configured', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: undefined }));
  let started = false;
  on('agent.spawn', () => {
    started = true;
    return { model: 'multi/cursor/auto', agentId: 'worker' };
  });
  const result = await $.agent.spawn({
    prompt: 'task',
    subagentType: 'cursor-auto',
    model: 'multi/cursor/auto',
  } as never);
  expect(result.agentId).toBe('worker');
  expect(started).toBe(true);
});

test('Claude-loop spawn proceeds when gateway is not configured', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: undefined }));
  on('agent.spawn', () => ({ model: 'multi/openai/gpt-6-luna', agentId: 'worker' }));
  const result = await $.agent.spawn({
    prompt: 'task',
    subagentType: 'openai-luna',
    model: 'multi/openai/gpt-6-luna',
  } as never);
  expect(result.agentId).toBe('worker');
});

for (const model of ['multi/openai/gpt-6-luna', 'multi/zen/gpt-6-luna']) {
  test(`${model} spawn survives an active gateway outage`, async ($, on) => {
    mock.clock(on);
    on('env.get', () => ({ value: 'configured' }));
    on('session.id', () => ({ value: 's' }));
    on('session.cwd', () => ({ value: '/workspace' }));
    on('http.fetch', () => ({ value: { ok: false, status: 503, headers: {}, text: '' } }));
    on('agent.spawn', () => ({ model, agentId: 'worker' }));
    const result = await $.agent.spawn({ prompt: 'task', subagentType: 'direct', model } as never);
    expect(result.agentId).toBe('worker');
  });
}

test('known catalog harness with omitted event model is admitted through worker-model', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: 'configured' }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('http.fetch', (_$, event) => {
    if (event.url.endsWith('/multi/mod/worker-model')) {
      return {
        value: {
          ok: true,
          status: 200,
          headers: {},
          text: '{"known":true,"execution":"harness","model":"multi/cursor/auto"}',
        },
      };
    }
    if (event.url.endsWith('/multi/mod/mode?sessionId=s')) {
      return { value: { ok: true, status: 200, headers: {}, text: '{"generation":4}' } };
    }
    return { value: { ok: true, status: 200, headers: {}, text: '{"accepted":true}' } };
  });
  on('agent.spawn', () => ({ model: 'multi/cursor/auto', agentId: 'worker' }));
  const result = await $.agent.spawn({ prompt: 'task', subagentType: 'cursor-auto' } as never);
  expect(result.agentId).toBe('worker');
});

test('a refused spawn shows the gateway reason instead of the generic denial', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: 'configured' }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('http.fetch', (_$, event) => ({
    value: {
      ok: event.url.includes('/mode?'),
      status: event.url.includes('/mode?') ? 200 : 400,
      headers: {},
      text: event.url.includes('/mode?')
        ? '{"generation":1}'
        : '{"error":"Claude permission mode is unavailable; submit a new prompt"}',
    },
  }));
  let started = false;
  on('agent.spawn', () => {
    started = true;
    return { model: 'm', agentId: 'worker' };
  });
  const result = await $.agent.spawn({
    prompt: 'task',
    subagentType: 'cursor',
    model: 'multi/cursor/auto',
  } as never);
  expect(result.deny).toContain('Claude permission mode is unavailable; submit a new prompt');
  expect(started).toBe(false);
});

test('a non-JSON gateway refusal still names the status in the denial', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: 'configured' }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('http.fetch', () => ({
    value: { ok: false, status: 502, headers: {}, text: 'upstream failure' },
  }));
  on('agent.spawn', () => ({ model: 'm', agentId: 'worker' }));
  const result = await $.agent.spawn({
    prompt: 'task',
    subagentType: 'cursor',
    model: 'multi/cursor/auto',
  } as never);
  expect(result.deny).toContain('gateway 502: upstream failure');
});

test('a refused reply cannot acknowledge a spawn through its body', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: 'configured' }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  // A contradictory body must not outrank the HTTP status.
  on('http.fetch', (_$, event) => ({
    value: {
      ok: false,
      status: 400,
      headers: {},
      text: event.url.includes('/mode?')
        ? '{"generation":1}'
        : '{"accepted":true,"error":"policy refused"}',
    },
  }));
  let started = false;
  on('agent.spawn', () => {
    started = true;
    return { model: 'm', agentId: 'worker' };
  });
  const result = await $.agent.spawn({
    prompt: 'task',
    subagentType: 'cursor',
    model: 'multi/cursor/auto',
  } as never);
  expect(result.deny).toContain('policy refused');
  expect(result.deny).toContain('issues/new?template=bug_report.yml');
  expect(started).toBe(false);
});

test('an unclassified refused offer remains available for the engine to decide', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: 'configured' }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('session.model', () => ({ value: 'claude-sonnet-5' }));
  on('http.fetch', () => ({
    value: { ok: false, status: 400, headers: {}, text: '{"isOffered":true}' },
  }));
  on('agent.offer', () => ({ isOffered: true }));
  const result = await $.agent.offer({
    agent: 'unknown',
    description: 'unknown',
    source: 'plugin',
    provider: { plugin: 'engine', tier: 'core' },
  });
  expect(result.isOffered).toBe(true);
});

type On = EngineOn;

/** A gateway whose catalog runs Cursor's default and Composer 2.5, and refuses the rest. */
function catalogGateway(on: On) {
  const sent: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  on('env.get', (_$, event) => ({
    value: event.name === 'MULTI_GATEWAY_TOKEN' ? 'token' : 'http://127.0.0.1:4000',
  }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('http.fetch', (_$, event) => {
    const body = event.init?.body
      ? (JSON.parse(String(event.init.body)) as Record<string, unknown>)
      : undefined;
    sent.push({ url: event.url, body });
    const reply = (status: number, value: unknown) => ({
      value: { ok: status === 200, status, headers: {}, text: JSON.stringify(value) },
    });
    if (event.url.endsWith('/multi/mod/worker-model')) {
      const named = body?.model ?? 'default';
      const known = ['default', 'composer-2.5', 'multi/cursor/composer-2.5'];
      if (body?.subagentType === 'multi-cursor' && !known.includes(String(named))) {
        return reply(400, {
          error: `multi-cursor has no model "${named}". Cursor models: default, composer-2.5. Omit model for the default, default.`,
        });
      }
      const id = String(named).replace('multi/cursor/', '');
      return reply(200, { known: true, execution: 'harness', model: `multi/cursor/${id}` });
    }
    if (event.url.includes('/multi/mod/mode?')) {
      return reply(200, { generation: 1 });
    }
    return reply(200, { accepted: true });
  });
  return sent;
}

test('an Agent call names the model: tool.call takes it out before the schema check', async ($, on) => {
  mock.clock(on);
  catalogGateway(on);
  const reached: Array<Record<string, unknown>> = [];
  on('tool.call', (_$, event) => {
    reached.push(event as Record<string, unknown>);
    return { result: 'launched' };
  });
  await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'toolu_cursor',
    description: 'Fix tests',
    prompt: 'task',
    subagent_type: 'multi-cursor',
    model: 'composer-2.5',
  } as never);
  // The Agent tool's schema admits only Claude aliases: a provider id must not reach it.
  expect(reached[0]?.model).toBeUndefined();
  expect(reached[0]?.subagent_type).toBe('multi-cursor');
  // Other agent types keep their Claude alias.
  await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'toolu_claude',
    description: 'Look',
    prompt: 'task',
    subagent_type: 'Explore',
    model: 'haiku',
  } as never);
  expect(reached[1]?.model).toBe('haiku');
});

test('agent.spawn resolves a provider worker model and runs the rewrite', async ($, on) => {
  mock.clock(on);
  const sent = catalogGateway(on);
  const spawned: Array<string | undefined> = [];
  const descriptions: string[] = [];
  on('agent.spawn', (_$, event) => {
    spawned.push(event.model);
    descriptions.push(event.description);
    return { model: event.model ?? 'unset', agentId: `agent-${spawned.length}` };
  });
  const named = await $.agent.spawn({
    prompt: 'task',
    description: 'Fix tests',
    subagentType: 'multi-cursor',
    model: 'composer-2.5',
  } as never);
  expect(named.agentId).toBe('agent-1');
  expect(spawned[0]).toBe('multi/cursor/composer-2.5');
  // The running-agents list and the notification show the task's description.
  expect(descriptions[0]).toBe('Fix tests · Cursor · composer-2.5');
  const resolution = sent.find((item) => item.url.endsWith('/multi/mod/worker-model'));
  expect(resolution?.body?.model).toBe('composer-2.5');
  // Admission sees the resolved model, not the short id.
  const admission = sent.filter((item) => item.url.endsWith('/multi/mod/worker')).at(-1);
  expect(admission?.body?.model).toBe('multi/cursor/composer-2.5');
  // No model: the provider default.
  await $.agent.spawn({ prompt: 'task', subagentType: 'multi-cursor' } as never);
  expect(spawned[1]).toBe('multi/cursor/default');
});

test('agent.spawn refuses an unknown provider model with the provider models named', async ($, on) => {
  mock.clock(on);
  catalogGateway(on);
  let started = false;
  on('agent.spawn', () => {
    started = true;
    return { model: 'm', agentId: 'worker' };
  });
  const result = await $.agent.spawn({
    prompt: 'task',
    subagentType: 'multi-cursor',
    model: 'kimi-k3',
  } as never);
  expect(result.deny).toBe(
    'multi-cursor has no model "kimi-k3". Cursor models: default, composer-2.5. Omit model for the default, default.',
  );
  expect(started).toBe(false);
});

test('a provider worker is refused when the gateway cannot resolve its model', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: 'configured' }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('http.fetch', () => {
    throw new Error('offline');
  });
  let started = false;
  on('agent.spawn', () => {
    started = true;
    return { model: 'm', agentId: 'worker' };
  });
  const result = await $.agent.spawn({
    prompt: 'task',
    subagentType: 'multi-zen',
    model: 'kimi-k3',
  } as never);
  expect(result.deny).toContain('The Multi gateway did not resolve the multi-zen model.');
  expect(started).toBe(false);
});

const provider = { plugin: 'engine', tier: 'core' } as const;

test('the Agent tool description names provider models only while a provider worker is offered', async ($, on) => {
  mock.clock(on);
  catalogGateway(on);
  on('session.model', () => ({ value: 'claude-sonnet-5' }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('tool.describe', (_$, event) => ({ description: event.description }));
  let offered = true;
  on('agent.offer', () => ({ isOffered: offered }));
  const describe = async () =>
    (await $.tool.describe({ tool: 'Agent', description: 'Launch a new agent.', provider }))
      .description;
  const offer = (agent: string) =>
    $.agent.offer({ agent, description: agent, source: 'plugin', provider });
  // No provider type offered: nothing to explain, so the description is the engine's own.
  expect(await describe()).toBe('Launch a new agent.');
  await offer('Explore');
  expect(await describe()).toBe('Launch a new agent.');
  await offer('multi-cursor');
  const described = await describe();
  expect(described).toContain('For a multi-* agent type');
  expect(described.startsWith('Launch a new agent.')).toBe(true);
  // The offer is withdrawn (settings the harness cannot honour): the paragraph goes too.
  offered = false;
  await offer('multi-cursor');
  expect(await describe()).toBe('Launch a new agent.');
});

/** The gateway classifies the type at offer, as it does before the model can name it. */
async function offerClaudeType($: TestEngine, on: On, agent: string) {
  on('agent.offer', () => ({ isOffered: true }));
  on('session.model', () => ({ value: 'claude-sonnet-5' }));
  await $.agent.offer({
    agent,
    description: agent,
    source: 'plugin',
    provider: { plugin: 'engine', tier: 'core' },
  });
}

/** A gateway that classifies every type as Claude-loop and records each call. */
function claudeGateway(on: On) {
  const sent: string[] = [];
  on('env.get', (_$, event) => ({
    value: event.name === 'MULTI_GATEWAY_TOKEN' ? 'token' : 'http://127.0.0.1:4000',
  }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('http.fetch', (_$, event) => {
    sent.push(event.url);
    return {
      value: {
        ok: true,
        status: 200,
        headers: {},
        text: '{"execution":"claude","isOffered":true}',
      },
    };
  });
  return sent;
}

test('a native Claude subagent spawns without any gateway call', async ($, on) => {
  mock.clock(on);
  const sent = claudeGateway(on);
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'native' }));
  await offerClaudeType($, on, 'Explore');
  const before = sent.length;
  const result = await $.agent.spawn({
    prompt: 'task',
    subagentType: 'Explore',
    model: 'haiku',
    parentModel: 'claude-sonnet-5',
  } as never);
  expect(result.agentId).toBe('native');
  expect(sent.length).toBe(before);
});

test('a subagent of a Multi model session still reaches the gateway', async ($, on) => {
  mock.clock(on);
  const sent = claudeGateway(on);
  on('agent.spawn', () => ({ model: 'multi/cursor/auto', agentId: 'inherited' }));
  await offerClaudeType($, on, 'Explore');
  const before = sent.length;
  await $.agent.spawn({
    prompt: 'task',
    subagentType: 'Explore',
    parentModel: 'multi/cursor/auto',
  } as never);
  expect(sent.length).toBeGreaterThan(before);
});

test('a type not offered as Claude-loop keeps gateway admission', async ($, on) => {
  mock.clock(on);
  const sent = catalogGateway(on);
  on('agent.spawn', () => ({ model: 'multi/cursor/auto', agentId: 'worker' }));
  await $.agent.spawn({
    prompt: 'task',
    subagentType: 'cursor-auto',
    parentModel: 'claude',
  } as never);
  expect(sent.some((item) => item.url.endsWith('/multi/mod/worker-model'))).toBe(true);
});

test('a Claude tool call posts nothing to the gateway', async ($, on) => {
  mock.clock(on);
  const sent = catalogGateway(on);
  on('session.model', () => ({ value: 'claude-sonnet-5' }));
  on('tool.call', () => ({ result: 'ran' }));
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_1' } as never);
  expect(sent.length).toBe(0);
});

test('a provider model tool call is attributed to the gateway reviewer', async ($, on) => {
  mock.clock(on);
  const sent = catalogGateway(on);
  on('session.model', () => ({ value: 'multi/openai/gpt-6-astra' }));
  on('tool.call', () => ({ result: 'ran' }));
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_1' } as never);
  expect(sent.map((item) => item.url.replace(/^.*(?=\/multi)/, ''))).toEqual(['/multi/permission']);
  expect(sent[0]?.body).toEqual({
    session_id: 's',
    tool_use_id: 'toolu_1',
    tool_name: 'Bash',
    cwd: '/workspace',
  });
});

/** A gateway whose offer answers name the model each agent type runs on. */
function pinnedGateway(
  on: On,
  models: Record<string, string>,
  bodies: Array<Record<string, unknown>> = [],
) {
  const sent: string[] = [];
  on('env.get', (_$, event) => ({
    value: event.name === 'MULTI_GATEWAY_TOKEN' ? 'token' : 'http://127.0.0.1:4000',
  }));
  on('session.id', () => ({ value: 's' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('session.model', () => ({ value: 'claude-sonnet-5' }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('http.fetch', (_$, event) => {
    sent.push(event.url);
    const body = event.init?.body ? JSON.parse(String(event.init.body)) : {};
    bodies.push(body);
    const model = models[String(body.agent ?? body.subagentType)] ?? 'claude-sonnet-5';
    return {
      value: {
        ok: true,
        status: 200,
        headers: {},
        text: JSON.stringify({
          execution: 'claude',
          known: true,
          isOffered: true,
          accepted: true,
          model,
        }),
      },
    };
  });
  return sent;
}

test('a custom agent pinned to a provider model keeps gateway registration', async ($, on) => {
  mock.clock(on);
  const sent = pinnedGateway(on, { reviewer: 'multi/openai/gpt-6-astra' });
  on('agent.offer', () => ({ isOffered: true }));
  on('agent.spawn', () => ({ model: 'multi/openai/gpt-6-astra', agentId: 'pinned' }));
  on('classic.SubagentStart', () => ({}));
  await $.agent.offer({ agent: 'reviewer', description: 'r', source: 'projectSettings', provider });
  await $.agent.offer({ agent: 'scout', description: 's', source: 'projectSettings', provider });
  // A definition on a Claude model stays native.
  const native = sent.length;
  await $.classic.SubagentStart({
    agent_id: 'plain',
    agent_type: 'scout',
    session_id: 's',
    cwd: '/workspace',
  });
  expect(sent.length).toBe(native);
  const before = sent.length;
  // The spawn event carries no model for the definition's pin: the offer classified it.
  await $.agent.spawn({
    prompt: 'task',
    subagentType: 'reviewer',
    parentModel: 'claude-sonnet-5',
  } as never);
  expect(sent.slice(before).some((url) => url.endsWith('/multi/mod/worker'))).toBe(true);
  const registered = sent.length;
  await $.classic.SubagentStart({
    agent_id: 'pinned',
    agent_type: 'reviewer',
    session_id: 's',
    cwd: '/workspace',
  });
  expect(sent.length).toBeGreaterThan(registered);
});

test('a built-in agent on a Claude session is classified without a gateway call', async ($, on) => {
  mock.clock(on);
  const sent = pinnedGateway(on, {});
  on('agent.offer', () => ({ isOffered: true }));
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'native' }));
  await $.agent.offer({ agent: 'Explore', description: 'e', source: 'built-in', provider });
  expect(sent).toEqual([]);
  await $.agent.spawn({
    prompt: 'task',
    subagentType: 'Explore',
    parentModel: 'claude-sonnet-5',
  } as never);
  expect(sent).toEqual([]);
});

test('a subagent registers with the gateway while any loop of the session runs a Multi model', async ($, on) => {
  mock.clock(on);
  const sent = pinnedGateway(on, {});
  on('agent.offer', () => ({ isOffered: true }));
  on('classic.SubagentStart', () => ({}));
  on('ui.status', () => ({ value: undefined }));
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text', index: 0, text: 'ok' };
    return {
      turnId: event.turnId,
      index: 0,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });
  await $.agent.offer({ agent: 'Explore', description: 'e', source: 'built-in', provider });
  const start = {
    agent_id: 'child',
    agent_type: 'Explore',
    session_id: 's',
    cwd: '/workspace',
  };
  const before = sent.length;
  await $.classic.SubagentStart(start);
  expect(sent.length).toBe(before);
  // A provider worker is stepping: a nested subagent may inherit its model.
  for await (const _chunk of $.turn.step({
    turnId: 't',
    agentId: 'provider-worker',
    index: 0,
    model: 'multi/openai/gpt-6-astra',
    messageCount: 1,
  })) {
    // Observe the step.
  }
  const afterStep = sent.length;
  await $.classic.SubagentStart(start);
  expect(sent.slice(afterStep).some((url) => url.endsWith('/multi/mod/worker'))).toBe(true);
});

test('a provider worker tool call is attributed to the reviewer with its agent id', async ($, on) => {
  mock.clock(on);
  const bodies: Array<Record<string, unknown>> = [];
  const sent = pinnedGateway(on, {}, bodies);
  on('tool.call', () => ({ result: 'ran' }));
  on('ui.status', () => ({ value: undefined }));
  on('classic.UserPromptSubmit', () => ({}));
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text', index: 0, text: 'ok' };
    return {
      turnId: event.turnId,
      index: 0,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });
  await $.classic.UserPromptSubmit({
    prompt: 'go',
    permission_mode: 'auto',
    session_id: 's',
    cwd: '/workspace',
  });
  for await (const _chunk of $.turn.step({
    turnId: 't',
    agentId: 'provider-worker',
    index: 0,
    model: 'multi/openai/gpt-6-astra',
    messageCount: 1,
  })) {
    // The hooks learn the worker's model from its step.
  }
  sent.length = 0;
  bodies.length = 0;
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_w', agentId: 'provider-worker' } as never);
  const index = sent.findIndex((url) => url.endsWith('/multi/permission'));
  expect(index).toBeGreaterThanOrEqual(0);
  // The Claude session's own mode (the engine hands a tool call none) comes from its snapshot.
  expect(bodies[index]).toEqual({
    session_id: 's',
    tool_use_id: 'toolu_w',
    tool_name: 'Bash',
    cwd: '/workspace',
    permission_mode: 'auto',
  });
  // The main loop is on Claude: its own call costs the gateway nothing.
  sent.length = 0;
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_main' } as never);
  expect(sent).toEqual([]);
});

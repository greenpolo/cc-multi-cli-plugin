import { expect, test } from 'claude-code/testing';
import { register } from '../workers.ts';

test('registers the worker admission hook', () => {
  expect(typeof register).toBe('function');
});

test('agent.offer hides an unsupported worker before dispatch', async ($, on) => {
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
  });
  expect(typeof result.deny).toBe('string');
  expect(started).toBe(false);
});

test('harness spawn remains dormant when gateway is not configured', async ($, on) => {
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
  });
  expect(result.agentId).toBe('worker');
  expect(started).toBe(true);
});

test('Claude-loop spawn proceeds when gateway is not configured', async ($, on) => {
  on('env.get', () => ({ value: undefined }));
  on('agent.spawn', () => ({ model: 'multi/openai/gpt-6-luna', agentId: 'worker' }));
  const result = await $.agent.spawn({
    prompt: 'task',
    subagentType: 'openai-luna',
    model: 'multi/openai/gpt-6-luna',
  });
  expect(result.agentId).toBe('worker');
});

for (const model of ['multi/openai/gpt-6-luna', 'multi/zen/gpt-6-luna']) {
  test(`${model} spawn survives an active gateway outage`, async ($, on) => {
    on('env.get', () => ({ value: 'configured' }));
    on('session.id', () => ({ value: 's' }));
    on('session.cwd', () => ({ value: '/workspace' }));
    on('http.fetch', () => ({ value: { ok: false, status: 503, headers: {}, text: '' } }));
    on('agent.spawn', () => ({ model, agentId: 'worker' }));
    const result = await $.agent.spawn({ prompt: 'task', subagentType: 'direct', model });
    expect(result.agentId).toBe('worker');
  });
}

test('known catalog harness with omitted event model is admitted through worker-model', async ($, on) => {
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
  const result = await $.agent.spawn({ prompt: 'task', subagentType: 'cursor-auto' });
  expect(result.agentId).toBe('worker');
});

test('a refused spawn shows the gateway reason instead of the generic denial', async ($, on) => {
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
  });
  expect(result.deny).toContain('Claude permission mode is unavailable; submit a new prompt');
  expect(started).toBe(false);
});

test('a non-JSON gateway refusal still names the status in the denial', async ($, on) => {
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
  });
  expect(result.deny).toContain('gateway 502: upstream failure');
});

test('a refused reply cannot acknowledge a spawn through its body', async ($, on) => {
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
  });
  expect(result.deny).toContain('policy refused');
  expect(result.deny).toContain('issues/new?template=bug_report.yml');
  expect(started).toBe(false);
});

test('an unclassified refused offer remains available for the engine to decide', async ($, on) => {
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

type On = Parameters<Parameters<typeof test>[1]>[1];

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
  });
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
  await $.agent.spawn({ prompt: 'task', subagentType: 'multi-cursor' });
  expect(spawned[1]).toBe('multi/cursor/default');
});

test('agent.spawn refuses an unknown provider model with the provider models named', async ($, on) => {
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
  });
  expect(result.deny).toBe(
    'multi-cursor has no model "kimi-k3". Cursor models: default, composer-2.5. Omit model for the default, default.',
  );
  expect(started).toBe(false);
});

test('a provider worker is refused when the gateway cannot resolve its model', async ($, on) => {
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
  });
  expect(result.deny).toContain('The Multi gateway did not resolve the multi-zen model.');
  expect(started).toBe(false);
});

test('the Agent tool description tells every model how to pick a provider model', async ($, on) => {
  catalogGateway(on);
  on('tool.describe', (_$, event) => ({ description: event.description }));
  const described = await $.tool.describe({
    tool: 'Agent',
    description: 'Launch a new agent.',
    provider: { plugin: 'engine', tier: 'core' },
  });
  expect(described.description).toContain('For a multi-* agent type');
  expect(described.description.startsWith('Launch a new agent.')).toBe(true);
});

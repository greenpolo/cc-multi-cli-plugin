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

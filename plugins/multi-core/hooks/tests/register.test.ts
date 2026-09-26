import { expect, mock, test } from 'claude-code/testing';

test('posts a session snapshot and registers no model-callable tools', async ($, on) => {
  mock.env(on, {
    MULTI_GATEWAY_TOKEN: 'test-token',
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
  });
  on('session.start', () => ({ cwd: '/tmp' }));
  const commands: string[] = [];
  on('command.register', (_$, event) => {
    commands.push(event.name);
    return { value: { command: event.name } };
  });
  const requests: string[] = [];
  on('session.id', () => ({ value: 'test-session' }));
  on('session.cwd', () => ({ value: '/tmp' }));
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  const tools: string[] = [];
  on('tool.register', (_$, event) => {
    tools.push(event.name);
    return { value: { tool: event.name } };
  });
  on('http.fetch', (_$, event) => {
    requests.push(event.url);
    return {
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ accepted: true }) },
    };
  });
  await $.session.start({ cwd: '/tmp', model: 'multi/cursor/auto' });
  expect(requests).toContain('http://127.0.0.1:4000/multi/mod/session');
  expect(commands).toEqual(['multi-usage']);
  expect(tools).toEqual([]);
});

test('mod is dormant without launcher environment', async ($, on) => {
  mock.env(on, {});
  on('session.start', () => ({ cwd: '/tmp' }));
  on('command.register', (_$, event) => ({ value: { command: event.name } }));
  on('session.id', () => ({ value: 'inactive-session' }));
  on('session.cwd', () => ({ value: '/tmp' }));
  on('session.model', () => ({ value: 'claude-sonnet' }));
  let fetches = 0;
  on('http.fetch', () => {
    fetches += 1;
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } };
  });
  await $.session.start({ cwd: '/tmp', model: 'claude-sonnet' });
  expect(fetches).toBe(0);
});

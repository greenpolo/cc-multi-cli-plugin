import { expect, mock, test } from 'claude-code/testing';

test('posts a session snapshot and registers no model-callable tools', async ($, on) => {
  mock.clock(on);
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
  await $.session.start({ cwd: '/tmp', model: 'multi/cursor/auto' } as never);
  expect(requests).toContain('http://127.0.0.1:4000/multi/mod/session');
  expect(commands).toEqual(['multi-usage']);
  expect(tools).toEqual([]);
});

test('mod is dormant without launcher environment', async ($, on) => {
  mock.clock(on);
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
  await $.session.start({ cwd: '/tmp', model: 'claude-sonnet' } as never);
  expect(fetches).toBe(0);
});

test('an unchanged Claude prompt posts nothing, and a changed mode posts again', async ($, on) => {
  mock.clock(on);
  mock.env(on, {
    MULTI_GATEWAY_TOKEN: 'test-token',
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
  });
  on('session.model', () => ({ value: 'claude-sonnet-5' }));
  on('classic.UserPromptSubmit', () => ({}));
  const posts: Array<Record<string, unknown>> = [];
  on('http.fetch', (_$, event) => {
    posts.push(event.init?.body ? JSON.parse(String(event.init.body)) : {});
    return {
      value: {
        ok: true,
        status: 200,
        headers: {},
        text: JSON.stringify({ accepted: true, generation: posts.length }),
      },
    };
  });
  const prompt = (mode: string) =>
    $.classic.UserPromptSubmit({
      prompt: 'go',
      permission_mode: mode,
      session_id: 's',
      cwd: '/workspace',
    });
  await prompt('default');
  // The first prompt greets the gateway (`start`) and records its snapshot.
  expect(posts.map((post) => post.event)).toEqual(['start', 'prompt']);
  await prompt('default');
  await prompt('default');
  expect(posts.length).toBe(2);
  await prompt('plan');
  expect(posts.map((post) => post.permissionMode)).toEqual([undefined, 'default', 'plan']);
});

test('a harness prompt always admits its policy, even when nothing changed', async ($, on) => {
  mock.clock(on);
  mock.env(on, {
    MULTI_GATEWAY_TOKEN: 'test-token',
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
  });
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  on('classic.UserPromptSubmit', () => ({}));
  const routes: string[] = [];
  on('http.fetch', (_$, event) => {
    routes.push(event.url.replace(/^.*\/multi/, '/multi'));
    return { value: { ok: true, status: 200, headers: {}, text: '{"revision":0,"names":[]}' } };
  });
  const send = () =>
    $.classic.UserPromptSubmit({
      prompt: 'go',
      permission_mode: 'default',
      session_id: 's',
      cwd: '/workspace',
    });
  await send();
  await send();
  expect(routes.filter((route) => route === '/multi/mod/policy').length).toBeGreaterThanOrEqual(2);
});

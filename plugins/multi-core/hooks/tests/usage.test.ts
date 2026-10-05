import { expect, mock, test } from 'claude-code/testing';

test('usage command reads only the current session without model dispatch', async ($, on) => {
  mock.clock(on);
  mock.env(on, {
    MULTI_GATEWAY_TOKEN: 'secret',
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
  });
  on('session.id', () => ({ value: 'session/one' }));
  on('ui.open', () => ({ value: { isPlaced: true as const } }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('http.fetch', (_$, event) => {
    expect(event.url).toBe(
      'http://127.0.0.1:4000/multi/mod/usage?sessionId=session%2Fone&view=providers',
    );
    expect(event.init?.method).toBe('GET');
    expect(event.init?.headers?.['x-multi-gateway-token']).toBe('secret');
    return {
      value: {
        ok: true,
        status: 200,
        headers: {},
        text: JSON.stringify({
          updatedAt: '2026-09-16T12:00:00Z',
          providers: [
            {
              id: 'openai',
              name: 'OpenAI',
              status: 'ready',
              summary: '10 tokens',
              details: ['input 6', 'output 4'],
            },
            {
              id: 'zen',
              name: 'Zen',
              status: 'unavailable',
              summary: 'Unavailable',
              details: ['not connected'],
            },
            { id: 'cursor', name: 'Cursor', status: 'disabled', summary: 'Disabled', details: [] },
            {
              id: 'antigravity',
              name: 'Antigravity',
              status: 'error',
              summary: 'Error',
              details: ['login required'],
            },
          ],
        }),
      },
    };
  });
  const result = await $.command.run({ command: 'multi-usage', args: '' } as never);
  expect(result.text).toBeUndefined();
  const rendered = await $.ui.render({
    surface: 'terminal',
    component: 'Pane',
    requestId: 'multi-usage',
    props: { title: 'Multi usage', isFocused: true, bodyColumns: 80 } as never,
  });
  expect(JSON.stringify(rendered)).toContain('usage-view.ts');
  expect(JSON.stringify(rendered)).toContain('OpenAI');
});

test('worker completion awaits accounting and preserves the engine answer', async ($, on) => {
  mock.clock(on);
  mock.env(on, {
    MULTI_GATEWAY_TOKEN: 'secret',
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
  });
  on('session.id', () => ({ value: 'session' }));
  let recorded = false;
  on('http.fetch', (_$, event) => {
    if (event.url.endsWith('/multi/mod/telemetry')) {
      return { value: { ok: true, status: 200, headers: {}, text: '{}' } };
    }
    expect(event.url).toBe('http://127.0.0.1:4000/multi/mod/usage/complete');
    expect(JSON.parse(event.init?.body ?? '{}')).toEqual({
      sessionId: 'session',
      agentId: 'worker',
      turnId: 'turn',
      outcome: 'answer',
    });
    recorded = true;
    return { value: { ok: true, status: 200, headers: {}, text: '{"accepted":true}' } };
  });
  on('ui.status', () => ({ value: undefined }));
  on('turn.complete', (_$, event) => {
    expect(recorded).toBe(true);
    return { text: event.answer };
  });
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text', index: 0, text: 'done' };
    return {
      turnId: event.turnId,
      index: 0,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });
  for await (const _chunk of $.turn.step({
    turnId: 'turn',
    index: 0,
    agentId: 'worker',
    model: 'multi/openai/gpt-6-astra',
    messageCount: 1,
  })) {
    // Let the model step complete before the engine emits turn.complete.
  }
  const result = await $.turn.complete({
    turnId: 'turn',
    agentId: 'worker',
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    reason: 'answer',
  });
  expect(result.text).toBe('done');
});

test('usage without a gateway reports unavailable without opening a pane', async ($, on) => {
  mock.clock(on);
  mock.env(on, {});
  on('session.id', () => ({ value: 'session' }));
  const result = await $.command.run({ command: 'multi-usage', args: '' } as never);
  expect(result.text).toContain('unavailable');
});

test('ordinary prompt submission no longer runs the quota advisory', async ($, on) => {
  mock.clock(on);
  on('prompt.submit', (_$, event) => ({ text: event.text, context: event.context }));
  const result = await $.prompt.submit({
    text: 'Choose a worker',
    context: ['Existing guidance'],
  } as never);
  expect(result.text).toBe('Choose a worker');
  expect(result.context).toEqual(['Existing guidance']);
});

test('receipts show a worker context beside what it consumed', async ($, on) => {
  mock.clock(on);
  mock.env(on, {
    MULTI_GATEWAY_TOKEN: 'secret',
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
  });
  on('session.id', () => ({ value: 'session' }));
  on('ui.open', () => ({ value: { isPlaced: true as const } }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('http.fetch', (_$, event) => {
    const body = event.url.includes('/multi/mod/receipts')
      ? {
          receipts: [
            {
              agentId: 'antigravity-gemini-3.8-flash',
              outcome: 'completed',
              time: '2026-09-22T12:00:00Z',
              requests: 1,
              usage: {
                input_tokens: 812345,
                output_tokens: 4096,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
                model_calls: 19,
              },
              context: {
                input_tokens: 20480,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
              entries: [],
            },
          ],
        }
      : { updatedAt: '2026-09-22T12:00:00Z', providers: [] };
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(body) } };
  });
  await $.command.run({ command: 'multi-usage', args: '' } as never);
  const pane = await $.ui.mount({
    plugin: 'multi-core',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'multi-usage',
    props: { title: 'Multi usage', isFocused: true, bodyColumns: 120 } as never,
  });
  await pane.resize({ columns: 120, rows: 20, in: 'usage' });
  await pane.press({ key: 'receipts' });
  expect((await pane.find({ type: 'Text', text: /^antigravity-gemini/, in: 'usage' }))?.text).toBe(
    'antigravity-gemini-3.8-flash · completed · 2026-09-22T12:00:00Z',
  );
  expect((await pane.find({ type: 'Text', text: /context/, in: 'usage' }))?.text).toBe(
    '  1 requests · 19 model calls · context 20,480 · consumed 812,345 input · cached 0 · 4,096 output',
  );
  await pane.unmount();
});

test('a pane that waits undrawn is announced and its numbers are shown as text', async ($, on) => {
  mock.clock(on);
  mock.env(on, {
    MULTI_GATEWAY_TOKEN: 'secret',
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
  });
  on('session.id', () => ({ value: 'session' }));
  on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'no surface places panes' } }));
  const toasts: string[] = [];
  on('ui.toast', (_$, event) => {
    toasts.push(event.text);
    return { value: undefined };
  });
  on('http.fetch', () => ({
    value: {
      ok: true,
      status: 200,
      headers: {},
      text: JSON.stringify({
        updatedAt: '2026-10-01T00:00:00Z',
        providers: [
          { id: 'openai', name: 'OpenAI', status: 'ready', summary: '10 tokens', details: [] },
        ],
      }),
    },
  }));
  const result = await $.command.run({ command: 'multi-usage', args: '' } as never);
  expect(result.text).toBe('OpenAI: 10 tokens');
  expect(toasts).toEqual(['Multi usage: no surface places panes']);
});

const dashboard = {
  updatedAt: 'today',
  providers: [
    {
      id: 'cursor',
      name: 'Cursor',
      status: 'ready',
      summary: '$0.00 charged',
      details: ['native spend'],
    },
  ],
};

/** A gateway serving the dashboard, and receipts for one worker, recording every URL read. */
function usageGateway(on: Parameters<typeof mock.env>[0], reads: string[]) {
  mock.clock(on);
  mock.env(on, { MULTI_GATEWAY_TOKEN: 'secret', MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000' });
  on('session.id', () => ({ value: 'session/one' }));
  on('session.model', () => ({ value: 'claude-sonnet-5' }));
  on('ui.open', () => ({ value: { isPlaced: true as const } }));
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never);
  on('http.fetch', (_$, event) => {
    reads.push(event.url.replace(/^.*\/multi/, '/multi'));
    const body = event.url.includes('/receipts')
      ? {
          receipts: [
            {
              agentId: 'worker',
              outcome: 'completed',
              time: 'today',
              requests: 1,
              usage: { input_tokens: 2, output_tokens: 3 },
            },
          ],
        }
      : dashboard;
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(body) } };
  });
}

test('refresh and receipts keep the providers, and another pane is not answered', async ($, on) => {
  const reads: string[] = [];
  usageGateway(on, reads);
  await $.command.run({ command: 'multi-usage', args: '' } as never);
  const pane = await $.ui.mount({
    plugin: 'multi-core',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'multi-usage',
    props: { title: 'Multi usage', isFocused: true, bodyColumns: 100 } as never,
  });
  await pane.resize({ columns: 100, rows: 20, in: 'usage' });
  await pane.press({ key: 'refresh' });
  expect(reads.at(-1)).toBe('/multi/mod/usage?sessionId=session%2Fone&view=providers&refresh=true');
  expect(await pane.find({ type: 'Text', text: /native spend|Cursor/, in: 'usage' })).toBeDefined();
  await pane.press({ key: 'receipts' });
  expect(reads.at(-1)).toBe('/multi/mod/receipts?sessionId=session%2Fone');
  expect((await pane.find({ type: 'Text', text: /^worker/, in: 'usage' }))?.text).toContain(
    'completed',
  );
  // The providers survive both messages.
  await pane.press({ key: 'cursor' });
  expect(await pane.find({ type: 'Text', text: /native spend/, in: 'usage' })).toBeDefined();
  await pane.unmount();
});

test('quota advice is opt-in, session scoped and ends with the session', async ($, on) => {
  const reads: string[] = [];
  usageGateway(on, reads);
  on('tool.call', () => ({ result: 'launched' }));
  on('session.end', (_$, event) => ({ sessionId: event.sessionId }));
  on('ui.status', () => ({ value: undefined }));
  const agentCall = {
    tool: 'Agent',
    tool_use_id: 'call-1',
    prompt: 'work',
    subagent_type: 'cursor',
  };
  const advice = async () => {
    reads.length = 0;
    const result = await $.tool.call(agentCall as never);
    return { reads: reads.filter((url) => url.startsWith('/multi/mod/usage')), result };
  };
  // Off by default: delegating reads no quota.
  expect((await advice()).reads).toEqual([]);
  await $.command.run({ command: 'multi-usage', args: '' } as never);
  const pane = await $.ui.mount({
    plugin: 'multi-core',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'multi-usage',
    props: { title: 'Multi usage', isFocused: true, bodyColumns: 100 } as never,
  });
  await pane.press({ key: 'quota-advice' });
  expect((await advice()).reads.length).toBe(1);
  // Only an Agent call is advised.
  reads.length = 0;
  await $.tool.call({ tool: 'Read', tool_use_id: 'call-2', file_path: '/a' } as never);
  expect(reads.filter((url) => url.startsWith('/multi/mod/usage'))).toEqual([]);
  await pane.press({ key: 'quota-advice' });
  expect((await advice()).reads).toEqual([]);
  await pane.press({ key: 'quota-advice' });
  expect((await advice()).reads.length).toBe(1);
  // The session's end forgets the opt-in.
  await $.session.end({ reason: 'clear', sessionId: 'session/one', resume: { id: 'x' } } as never);
  expect((await advice()).reads).toEqual([]);
  await pane.unmount();
});

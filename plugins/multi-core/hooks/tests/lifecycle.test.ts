import { expect, mock, test } from 'claude-code/testing';

test('turn.step telemetry preserves core model, effort and streamed chunks', async ($, on) => {
  mock.clock(on);
  mock.env(on, {});
  on('session.id', () => ({ value: 's' }));
  on('turn.step', async function* (_$, event) {
    expect(event.model).toBe('multi/openai/gpt-6-astra');
    expect(event.effort).toBe('high');
    yield { kind: 'text', index: 0, text: 'core response' };
    return {
      turnId: event.turnId,
      index: event.index,
      answer: 'core response',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });
  const chunks: string[] = [];
  for await (const chunk of $.turn.step({
    turnId: 't',
    index: 0,
    model: 'multi/openai/gpt-6-astra',
    effort: 'high',
    messageCount: 1,
  })) {
    if (chunk.kind === 'text') {
      chunks.push(chunk.text);
    }
  }
  expect(chunks).toEqual(['core response']);
});

test('Claude completion does not wait on Multi accounting or clear another provider status', async ($, on) => {
  mock.clock(on);
  mock.env(on, {
    MULTI_GATEWAY_TOKEN: 'secret',
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
  });
  on('session.id', () => ({ value: 's' }));
  const routes: string[] = [];
  on('http.fetch', (_$, event) => {
    routes.push(event.url);
    return { value: { ok: false, status: 503, headers: {}, text: '{}' } };
  });
  let statusChanges = 0;
  on('ui.status', () => {
    statusChanges += 1;
    return { value: undefined };
  });
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text', index: 0, text: 'native answer' };
    return {
      turnId: event.turnId,
      index: 0,
      answer: 'native answer',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });
  on('turn.complete', (_$, event) => ({ text: event.answer }));
  for await (const _chunk of $.turn.step({
    turnId: 'native-turn',
    index: 0,
    model: 'claude-sonnet-5',
    messageCount: 1,
  })) {
    // Observe the same completed inference step as the engine.
  }
  const result = await $.turn.complete({
    turnId: 'native-turn',
    answer: 'native answer',
    durationMs: 1,
    isAborted: true,
    reason: 'aborted',
  });
  expect(result.text).toBe('native answer');
  expect(
    routes.some((route) => route.endsWith('/usage/complete') || route.endsWith('/compact/cancel')),
  ).toBe(false);
  expect(statusChanges).toBe(0);
});

test('a completed harness child retains its provider for compaction between turns', async ($, on) => {
  mock.clock(on);
  mock.env(on, { MULTI_GATEWAY_TOKEN: 'secret', MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000' });
  on('session.id', () => ({ value: 's' }));
  on('session.model', () => ({ value: 'claude-sonnet-5' }));
  on('ui.status', () => ({ value: undefined }));
  on('http.fetch', () => ({ value: { ok: false, status: 409, headers: {}, text: '{}' } }));
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
  on('turn.complete', (_$, event) => ({ text: event.answer }));
  on('session.compact', () => ({ skip: 'core compaction' }));
  for await (const _chunk of $.turn.step({
    turnId: 't',
    agentId: 'child',
    index: 0,
    model: 'multi/cursor/auto',
    messageCount: 1,
  })) {
    // Retain the model observed during inference.
  }
  await $.turn.complete({
    turnId: 't',
    agentId: 'child',
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    reason: 'answer',
  });
  expect((await $.session.compact({ agentId: 'child' } as never)).skip).toBe(
    'Multi compaction policy generation is unavailable.',
  );
});

const gatewayEnv = {
  MULTI_GATEWAY_TOKEN: 'secret',
  MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
};
const stepResult = (event: { turnId: string }) => ({
  turnId: event.turnId,
  index: 0,
  answer: 'done',
  toolUses: [],
  stopReason: 'end_turn' as const,
  usage: null,
});

test('a harness step polls the run status on the clock until its turn completes', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, gatewayEnv);
  on('session.id', () => ({ value: 's' }));
  const lifecycleReads: string[] = [];
  on('http.fetch', (_$, event) => {
    const reply = (value: unknown) => ({
      value: { ok: true, status: 200, headers: {}, text: JSON.stringify(value) },
    });
    if (event.url.includes('/multi/mod/lifecycle')) {
      lifecycleReads.push(event.url);
      return reply({
        model: 'multi/cursor/auto',
        state: 'running',
        detail: 'reading',
        elapsedMs: 3000,
        startedAt: 10,
      });
    }
    return reply({ revision: 1, names: [], accepted: true });
  });
  const lines: Array<string | undefined> = [];
  on('ui.status', (_$, event) => {
    lines.push(event.text);
    return { value: undefined };
  });
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text', index: 0, text: 'done' };
    return stepResult(event);
  });
  on('turn.complete', (_$, event) => ({ text: event.answer }));
  for await (const _chunk of $.turn.step({
    turnId: 't',
    index: 0,
    model: 'multi/cursor/auto',
    messageCount: 1,
  })) {
    // The run is under way once its step began.
  }
  // Nothing polls outside the clock: the first read comes when the clock reaches it.
  expect(lifecycleReads.length).toBe(0);
  await clock.advance(500);
  expect(lifecycleReads.length).toBe(1);
  expect(lifecycleReads[0]).toContain('sessionId=s&agentId=main');
  expect(lines.at(-1)).toBe('multi/cursor/auto · main · running · 3s reading');
  await clock.advance(1000);
  expect(lifecycleReads.length).toBe(3);
  await $.turn.complete({
    turnId: 't',
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    reason: 'answer',
  });
  expect(lines.at(-1)).toBe(undefined);
  await clock.advance(5000);
  expect(lifecycleReads.length).toBe(3);
});

test('a Claude step costs the gateway no telemetry and starts no poll', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, gatewayEnv);
  on('session.id', () => ({ value: 's' }));
  const urls: string[] = [];
  on('http.fetch', (_$, event) => {
    urls.push(event.url);
    return { value: { ok: true, status: 200, headers: {}, text: '{}' } };
  });
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text', index: 0, text: 'done' };
    return stepResult(event);
  });
  for await (const _chunk of $.turn.step({
    turnId: 't',
    index: 0,
    model: 'claude-sonnet-5',
    messageCount: 1,
  })) {
    // A native step.
  }
  await clock.advance(5000);
  expect(urls).toEqual([]);
  // A provider-loop (not harness) step reports its model and effort, and polls nothing.
  for await (const _chunk of $.turn.step({
    turnId: 't2',
    index: 0,
    model: 'multi/openai/gpt-6-astra',
    effort: 'high',
    messageCount: 1,
  })) {
    // The gateway reads this step's model and effort before its request.
  }
  await clock.advance(5000);
  expect(urls).toEqual(['http://127.0.0.1:4000/multi/mod/telemetry']);
});

test('a request that outlasts its bound gives up on the clock, not on a timer', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, gatewayEnv);
  on('session.id', () => ({ value: 's' }));
  on('http.fetch', () => new Promise<never>(() => undefined));
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text', index: 0, text: 'done' };
    return stepResult(event);
  });
  let stepped = false;
  const step = (async () => {
    for await (const _chunk of $.turn.step({
      turnId: 't',
      index: 0,
      model: 'multi/openai/gpt-6-astra',
      messageCount: 1,
    })) {
      // The step waits on its telemetry post.
    }
    stepped = true;
  })();
  await clock.advance(1499);
  expect(stepped).toBe(false);
  await clock.advance(1);
  await step;
  expect(stepped).toBe(true);
});

test('session end forgets the gateway session, while a client leaving does not', async ($, on) => {
  mock.clock(on);
  mock.env(on, gatewayEnv);
  on('session.id', () => ({ value: 'ending' }));
  on('session.end', (_$, event) => ({ sessionId: event.sessionId }));
  on('ui.status', () => ({ value: undefined }));
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  on('http.fetch', (_$, event) => {
    posts.push({
      url: event.url,
      body: event.init?.body ? JSON.parse(String(event.init.body)) : {},
    });
    return { value: { ok: true, status: 200, headers: {}, text: '{"accepted":true}' } };
  });
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text', index: 0, text: 'done' };
    return stepResult(event);
  });
  for await (const _chunk of $.turn.step({
    turnId: 't',
    agentId: 'worker',
    index: 0,
    model: 'multi/openai/gpt-6-astra',
    messageCount: 1,
  })) {
    // A provider worker's model is recorded.
  }
  posts.length = 0;
  await $.session.end({ reason: 'clear', sessionId: 'ending', resume: { id: 'ending' } } as never);
  expect(posts).toEqual([
    { url: 'http://127.0.0.1:4000/multi/mod/detach', body: { sessionId: 'ending' } },
  ]);
});

test('the gateway session key is captured, echoed, and cleared at session end', async ($, on) => {
  mock.clock(on);
  mock.env(on, gatewayEnv);
  on('session.id', () => ({ value: 'keyed' }));
  on('session.end', (_$, event) => ({ sessionId: event.sessionId }));
  on('ui.status', () => ({ value: undefined }));
  const sent: Array<{ route: string; key: string | undefined }> = [];
  on('http.fetch', (_$, event) => {
    const headers = event.init?.headers as Record<string, string> | undefined;
    sent.push({ route: new URL(event.url).pathname, key: headers?.['x-multi-mod-key'] });
    const issued: Record<string, string> = headers?.['x-multi-mod-key']
      ? {}
      : { 'x-multi-mod-key': 'issued-key' };
    return { value: { ok: true, status: 200, headers: issued, text: '{"accepted":true}' } };
  });
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text', index: 0, text: 'done' };
    return stepResult(event);
  });
  const step = async (turnId: string) => {
    for await (const _chunk of $.turn.step({
      turnId,
      agentId: 'worker',
      index: 0,
      model: 'multi/openai/gpt-6-astra',
      messageCount: 1,
    })) {
      // Each step posts telemetry for the session.
    }
  };
  await step('t1');
  await step('t2');
  expect(sent.map((request) => request.key)).toEqual([undefined, 'issued-key']);
  await $.session.end({ reason: 'clear', sessionId: 'keyed', resume: { id: 'keyed' } } as never);
  expect(sent.at(-1)).toEqual({ route: '/multi/mod/detach', key: 'issued-key' });
  await step('t3');
  expect(sent.at(-1)?.key).toBe(undefined);
});

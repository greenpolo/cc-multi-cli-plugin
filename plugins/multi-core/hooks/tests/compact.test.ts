import { expect, mock, test } from 'claude-code/testing';
import { register } from '../compact.ts';

test('registers the compaction boundary hook', () => {
  expect(typeof register).toBe('function');
});

test('compaction with an unknown generation skips without calling core', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: 'configured' }));
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  on('session.id', () => ({ value: 's' }));
  on('http.fetch', () => ({ value: { ok: false, status: 409, headers: {}, text: '{}' } }));
  let core = false;
  on('session.compact', () => {
    core = true;
    return { skip: 'core' };
  });
  const result = await $.session.compact({} as never);
  expect(result.skip).toBe('Multi compaction policy generation is unavailable.');
  expect(core).toBe(false);
});

test('a stale digest falls through to core compaction', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: 'configured' }));
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  on('session.id', () => ({ value: 's' }));
  on('http.fetch', (_$, event) => ({
    value: {
      ok: true,
      status: 200,
      headers: {},
      text: event.url.includes('/mode?') ? '{"generation":1}' : '{"allow":true}',
    },
  }));
  on('session.compact', () => ({ skip: 'core fallback' }));
  const result = await $.session.compact({} as never);
  expect(result.skip).toBe('core fallback');
});

test('failed fallback authorization skips instead of running core with ordinary tools', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: 'configured' }));
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  on('session.id', () => ({ value: 's' }));
  on('http.fetch', (_$, event) => ({
    value: { ok: event.url.includes('/mode?'), status: 200, headers: {}, text: '{"generation":1}' },
  }));
  let core = false;
  on('session.compact', () => {
    core = true;
    return { skip: 'core' };
  });
  const result = await $.session.compact({} as never);
  expect(result.skip).toBe('Multi tool-free compaction authorization was not acknowledged.');
  expect(core).toBe(false);
});

test('ready authenticated summary replaces the transcript without calling core', async ($, on) => {
  mock.clock(on);
  on('env.get', () => ({ value: 'configured' }));
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  on('session.id', () => ({ value: 's' }));
  on('http.fetch', (_$, event) => ({
    value: {
      ok: true,
      status: 200,
      headers: {},
      text: event.url.includes('/mode?')
        ? '{"generation":1}'
        : '{"allow":true,"messages":[{"role":"user","text":"summary","toolUses":[]}]}',
    },
  }));
  let core = false;
  on('session.compact', () => {
    core = true;
    return { skip: 'core' };
  });
  const result = await $.session.compact({} as never);
  expect(result.messages?.[0]?.text).toBe('summary');
  expect(core).toBe(false);
});

for (const model of [
  'claude-opus-4-6',
  'claude-sonnet-5',
  'opus',
  'sonnet',
  'multi/openai/gpt-6-astra',
  'multi/zen/glm-5',
]) {
  test(`native ${model} compacts without consulting the gateway`, async ($, on) => {
    mock.clock(on);
    on('session.model', () => ({ value: model }));
    on('env.get', () => ({ value: 'configured' }));
    let fetches = 0;
    on('http.fetch', () => {
      fetches += 1;
      return { value: { ok: false, status: 409, headers: {}, text: '{}' } };
    });
    on('session.compact', () => ({ skip: 'native compaction reached' }));
    const result = await $.session.compact({} as never);
    expect(result.skip).toBe('native compaction reached');
    expect(fetches).toBe(0);
  });
}

test('compaction uses the child model without borrowing its parent model', async ($, on) => {
  mock.clock(on);
  mock.env(on, { MULTI_GATEWAY_TOKEN: 'secret', MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000' });
  on('session.model', () => ({ value: 'multi/cursor/auto' }));
  on('session.id', () => ({ value: 's' }));
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
  on('session.compact', () => ({ skip: 'native compaction reached' }));
  on('http.fetch', () => ({ value: { ok: false, status: 409, headers: {}, text: '{}' } }));
  // The hooks record each loop's model as it steps; that record is what compaction reads.
  for (const [agentId, model] of [
    ['claude-child', 'claude-sonnet-5'],
    ['external-child', 'multi/cursor/auto'],
  ] as const) {
    for await (const _chunk of $.turn.step({
      turnId: agentId,
      agentId,
      index: 0,
      model,
      messageCount: 1,
    })) {
      // Observe the step, as the engine does.
    }
  }
  const transcript = [{ role: 'user' as const, text: 'hello', toolUses: [] }];
  // A Claude child compacts natively, whatever the main loop runs on.
  expect(
    (
      await $.session.compact({
        agentId: 'claude-child',
        trigger: 'auto',
        messages: transcript,
      } as never)
    ).skip,
  ).toBe('native compaction reached');
  // A harness child is held to the gateway's generation, which this gateway does not have.
  expect(
    (
      await $.session.compact({
        agentId: 'external-child',
        trigger: 'auto',
        messages: transcript,
      } as never)
    ).skip,
  ).toBe('Multi compaction policy generation is unavailable.');
  // An unrecorded child's model is unknown, never its parent's.
  expect(
    (
      await $.session.compact({
        agentId: 'unknown-child',
        trigger: 'auto',
        messages: transcript,
      } as never)
    ).skip,
  ).toBe('native compaction reached');
});

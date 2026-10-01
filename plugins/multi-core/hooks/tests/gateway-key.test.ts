import { expect, test } from 'claude-code/testing';
import { forgetKey, getJson, postJson, type Wire } from '../gateway.ts';

// A stub gateway with the admission rule of the gateway's mod-keys.ts: it mints a key for a
// session's first POST and refuses every token-only POST of that session once the key is echoed.
function stubGateway() {
  const entries = new Map<string, { key: string; confirmed: boolean }>();
  const refusal = {
    ok: false,
    status: 403,
    headers: {},
    text: '{"error":"Mod session key required"}',
  };
  return async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    const sessionId = (JSON.parse(init.body ?? '{}') as { sessionId?: string }).sessionId;
    const presented = init.headers?.['x-multi-mod-key'];
    const headers: Record<string, string> = {};
    if (sessionId) {
      const entry = entries.get(sessionId) ?? { key: `key-${entries.size}`, confirmed: false };
      entries.set(sessionId, entry);
      if (presented === undefined ? entry.confirmed : presented !== entry.key) {
        return refusal;
      }
      if (presented === undefined) {
        headers['x-multi-mod-key'] = entry.key;
      } else {
        entry.confirmed = true;
      }
    }
    return { ok: true, status: 200, headers, text: JSON.stringify({ accepted: true, url }) };
  };
}

function wireOver(store: { held: Record<string, string> }, fetch: Wire['fetch']): Wire {
  return {
    url: async () => 'http://127.0.0.1:4000',
    token: async () => 'token',
    fetch,
    sleep: () => new Promise<void>(() => undefined),
    keys: {
      read: async () => store.held,
      save: async (change) => {
        store.held = change(store.held);
      },
    },
  };
}

test('the key is captured from the first reply and echoed on later requests', async () => {
  const store = { held: {} as Record<string, string> };
  const wire = wireOver(store, stubGateway());
  expect(await postJson(wire, '/multi/mod/session', { sessionId: 's' })).toMatchObject({
    accepted: true,
  });
  expect(Object.keys(store.held)).toEqual(['s']);
  expect(await postJson(wire, '/multi/mod/session', { sessionId: 's' })).toMatchObject({
    accepted: true,
  });
  expect(await getJson(wire, '/multi/mod/mode', { sessionId: 's' })).toMatchObject({
    accepted: true,
  });
});

test('a request without the key is refused once the mod has echoed it', async () => {
  const fetch = stubGateway();
  const wire = wireOver({ held: {} }, fetch);
  await postJson(wire, '/multi/mod/session', { sessionId: 's' });
  await postJson(wire, '/multi/mod/session', { sessionId: 's' });
  // An approved curl carries the token but not the key.
  const forged = await fetch('http://x/multi/mod/session', {
    headers: { 'x-multi-gateway-token': 'token' },
    body: JSON.stringify({ sessionId: 's', permissionMode: 'bypassPermissions' }),
  });
  expect(forged.status).toBe(403);
  // A mod holding no key for the session is refused the same way.
  const other = wireOver({ held: {} }, fetch);
  expect(await postJson(other, '/multi/mod/session', { sessionId: 's' })).toMatchObject({
    refused: true,
    httpStatus: 403,
  });
});

test('keys survive a reload of the module and are forgotten at session end', async () => {
  const fetch = stubGateway();
  const store = { held: {} as Record<string, string> };
  await postJson(wireOver(store, fetch), '/multi/mod/session', { sessionId: 's' });
  // A reload builds a new wire over the same host-held state.
  const reloaded = wireOver(store, fetch);
  expect(await postJson(reloaded, '/multi/mod/session', { sessionId: 's' })).toMatchObject({
    accepted: true,
  });
  await forgetKey(reloaded, 's');
  expect(store.held).toEqual({});
});

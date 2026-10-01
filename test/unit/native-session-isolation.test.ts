import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { ModSessionKeys } from '../../plugins/multi-core/src/gateway/mod-keys.ts';
import {
  nestedClaudeShim,
  withPathPrefix,
} from '../../plugins/multi-core/src/gateway/nested-env.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import {
  needsEnvProxy,
  rememberOriginalEnvironment,
  withoutGateway,
} from '../../plugins/multi-core/src/install/process.ts';

test('a nested Claude run gets the session start environment back, not the gateway', () => {
  const original = {
    ANTHROPIC_BASE_URL: 'https://corp.example',
    ANTHROPIC_CUSTOM_HEADERS: 'x-team: a',
  };
  const session: NodeJS.ProcessEnv = {
    ...rememberOriginalEnvironment(original),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    ANTHROPIC_CUSTOM_HEADERS: 'x-team: a\nx-multi-gateway-token: tok',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    MULTI_GATEWAY_TOKEN: 'tok',
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:1',
    KEEP: 'yes',
  };
  assert.deepEqual(withoutGateway(session), {
    ANTHROPIC_BASE_URL: 'https://corp.example',
    ANTHROPIC_CUSTOM_HEADERS: 'x-team: a',
    KEEP: 'yes',
  });
  // A caller with no base URL of its own ends with none.
  const bare = withoutGateway({
    ...rememberOriginalEnvironment({}),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    MULTI_GATEWAY_TOKEN: 'tok',
  });
  assert.deepEqual(bare, {});
  const plain = { ANTHROPIC_BASE_URL: 'https://x' };
  assert.equal(withoutGateway(plain), plain);
});

test('the nested claude shim quotes its paths and goes first on PATH', () => {
  const posix = nestedClaudeShim({
    platform: 'linux',
    node: "/opt/no'de",
    script: '/p/nested-claude.ts',
    claude: '/c/claude',
  });
  assert.equal(posix.file, 'claude');
  assert.equal(
    posix.content,
    `#!/bin/sh\nexec '/opt/no'\\''de' '/p/nested-claude.ts' '/c/claude' "$@"\n`,
  );
  assert.equal(
    nestedClaudeShim({ platform: 'win32', node: 'n', script: 's', claude: 'c' }).file,
    'claude.cmd',
  );
  assert.equal(withPathPrefix({ PATH: '/a' }, '/s', 'linux').PATH, '/s:/a');
  assert.equal(withPathPrefix({ Path: 'C:\\a' }, 'C:\\s', 'win32').Path, 'C:\\s;C:\\a');
});

test('a proxy in the environment needs Node started with NODE_USE_ENV_PROXY', () => {
  assert.equal(needsEnvProxy({ HTTPS_PROXY: 'http://p' }), true);
  assert.equal(needsEnvProxy({ https_proxy: 'http://p', NODE_USE_ENV_PROXY: '1' }), false);
  assert.equal(needsEnvProxy({}), false);
});

async function listen(t: TestContext) {
  const server = createNativeGateway({
    token: 'tok',
    authFile: '/unused',
    guardAuto: true,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return (session: string, key?: string, route = 'session') =>
    fetch(`http://127.0.0.1:${address.port}/multi/mod/${route}`, {
      method: 'POST',
      headers: { 'x-multi-gateway-token': 'tok', ...(key ? { 'x-multi-mod-key': key } : {}) },
      body: JSON.stringify({ sessionId: session, permissionMode: 'default' }),
    });
}

test('once the mod presents its session key, the token alone cannot change that session', async (t) => {
  const post = await listen(t);
  const first = await post('s1');
  const key = first.headers.get('x-multi-mod-key');
  assert(key, 'the first request for a session is handed a key');
  // Until the mod echoes it, requests stay admitted (a mod without the protocol works).
  assert.notEqual((await post('s1')).status, 403);
  assert.notEqual((await post('s1', key)).status, 403);
  // Confirmed: a caller holding only the token, as a Bash `curl` does, is refused.
  const bare = await post('s1');
  assert.equal(bare.status, 403);
  assert.equal(bare.headers.get('x-multi-mod-key'), null);
  assert.equal((await post('s1', 'wrong')).status, 403);
  assert.notEqual((await post('s1', key)).status, 403);
  // Another session has its own key.
  assert.notEqual((await post('s2')).status, 403);
});

test('detaching a session drops its key so a reused session ID is issued a fresh one', async (t) => {
  const post = await listen(t);
  const key = (await post('s1')).headers.get('x-multi-mod-key');
  assert(key);
  assert.notEqual((await post('s1', key)).status, 403);
  assert.equal((await post('s1')).status, 403);
  assert.equal((await post('s1', key, 'detach')).status, 200);
  const reused = await post('s1');
  assert.notEqual(reused.status, 403);
  assert.notEqual(reused.headers.get('x-multi-mod-key'), null);
});

test('minting fake sessions cannot evict a confirmed session key', () => {
  const keys = new ModSessionKeys();
  const real = keys.check('real', undefined);
  assert(!real.refused && real.issue);
  assert.deepEqual(keys.check('real', real.issue), { refused: false });
  for (let index = 0; index < 2048; index++) {
    keys.check(`fake-${index}`, undefined);
  }
  assert.deepEqual(keys.check('real', undefined), { refused: true });
  assert.deepEqual(keys.check('real', real.issue), { refused: false });
});

test('a full table of confirmed sessions still admits a new one by evicting the oldest', () => {
  const keys = new ModSessionKeys();
  for (let index = 0; index < 1024; index++) {
    const verdict = keys.check(`s-${index}`, undefined);
    assert(!verdict.refused && verdict.issue);
    keys.check(`s-${index}`, verdict.issue);
  }
  assert(!keys.check('new', undefined).refused);
  assert.equal(keys.check('s-0', undefined).refused, false);
  assert.equal(keys.check('s-2', undefined).refused, true);
});

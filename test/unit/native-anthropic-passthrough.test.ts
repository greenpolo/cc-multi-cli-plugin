import assert from 'node:assert/strict';
import http from 'node:http';
import type { TestContext } from 'node:test';
import test from 'node:test';
import type { GatewayFetch } from '../../plugins/multi-core/src/gateway/fetch.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';

async function listen(t: TestContext, fetchImpl: GatewayFetch) {
  const server = createNativeGateway({
    token: 'local-test-secret',
    authFile: '/nonexistent/auth.json',
    fetchImpl,
    guardAuto: true,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address !== null && typeof address === 'object', 'Gateway port');
  return address.port;
}

const truncated = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Write","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\": \\"/tm"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
].join('');

test('a tool_use truncated by max_tokens streams through byte for byte', async (t) => {
  const port = await listen(
    t,
    async () =>
      new Response(truncated, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'x-multi-gateway-token': 'local-test-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      stream: true,
      tools: [{ name: 'Write', input_schema: { type: 'object' } }],
      messages: [],
    }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text, truncated);
  assert(!text.includes('Native gateway'));
});

test('Anthropic connection failures are not rebranded and upstream errors pass through', async (t) => {
  let fail = true;
  const port = await listen(t, async () => {
    if (fail) {
      throw new TypeError('fetch failed');
    }
    return new Response('{"type":"error"}', { status: 529 });
  });
  const send = () =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'x-multi-gateway-token': 'local-test-secret' },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
    });
  await assert.rejects(send());
  fail = false;
  const response = await send();
  assert.equal(response.status, 529);
  assert.equal(await response.text(), '{"type":"error"}');
});

test('a mid-stream Anthropic failure ends the response without an injected event', async (t) => {
  const port = await listen(t, async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'));
        controller.error(new Error('upstream reset'));
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  let received = '';
  await new Promise<void>((resolve) => {
    const request = http.request(
      `http://127.0.0.1:${port}/v1/messages`,
      { method: 'POST', headers: { 'x-multi-gateway-token': 'local-test-secret' } },
      (res) => {
        res.on('data', (chunk) => {
          received += chunk;
        });
        res.on('error', () => resolve());
        res.on('close', () => resolve());
      },
    );
    request.on('error', () => resolve());
    request.end(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));
  });
  assert(!received.includes('Native gateway'));
  assert(!received.includes('event: error'));
});

test('/v1 routes the gateway does not own are forwarded as raw bytes without its token', async (t) => {
  const seen: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];
  const port = await listen(t, async (url, init) => {
    const body = init.body ? Buffer.from(await new Response(init.body).arrayBuffer()) : undefined;
    seen.push({
      url,
      method: init.method,
      body: body?.toString('latin1') ?? '',
      headers: init.headers,
    });
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  });
  const bytes = Buffer.from([0, 255, 13, 10, 45, 45, 1, 2, 3]);
  const upload = await fetch(`http://127.0.0.1:${port}/v1/files?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x', 'x-api-key': 'caller-key' },
    body: bytes,
  });
  assert.equal(upload.status, 200);
  const content = await fetch(`http://127.0.0.1:${port}/v1/files/file_1/content`, {
    headers: { authorization: 'Bearer caller' },
  });
  assert.equal(await content.text(), 'ok');
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/files?beta=true');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].body, bytes.toString('latin1'));
  assert.equal(seen[0].headers['x-api-key'], 'caller-key');
  assert.equal(seen[0].headers['content-type'], 'multipart/form-data; boundary=x');
  assert.equal(seen[1].url, 'https://api.anthropic.com/v1/files/file_1/content');
  assert.equal(seen[1].method, 'GET');
  assert.equal(seen[1].headers['x-multi-gateway-token'], undefined);
  const gated = await fetch(`http://127.0.0.1:${port}/multi/mod/session`, { method: 'POST' });
  assert.equal(gated.status, 401);
});

test('a request whose Host is not the gateway loopback name is refused before any relay', async (t) => {
  let relayed = 0;
  const port = await listen(t, async () => {
    relayed += 1;
    return new Response('ok');
  });
  const send = (host: string) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/v1/files', method: 'GET', headers: { host } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
  assert.equal(await send('evil.example'), 403);
  assert.equal(await send(`evil.example:${port}`), 403);
  assert.equal(await send('127.0.0.1'), 403);
  assert.equal(relayed, 0);
  assert.equal(await send(`localhost:${port}`), 200);
  assert.equal(await send(`[::1]:${port}`), 200);
  assert.equal(await send(`127.0.0.1:${port}`), 200);
  assert.equal(relayed, 3);
});

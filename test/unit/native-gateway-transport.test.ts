import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import test from 'node:test';
import type { GatewayFetch } from '../../plugins/multi-core/src/gateway/fetch.ts';
import type { GatewayEvent } from '../../plugins/multi-core/src/gateway/server.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';

const TOKEN = 'local-test-secret';

async function listen(t: TestContext, options: Partial<Parameters<typeof createNativeGateway>[0]>) {
  const server = createNativeGateway({
    token: TOKEN,
    authFile: '/nonexistent/auth.json',
    guardAuto: true,
    ...options,
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

test('a bodyless DELETE goes upstream without a streamed body', async (t) => {
  const seen: { url: string; method: string; body: unknown; duplex: unknown }[] = [];
  const fetchImpl: GatewayFetch = async (url, init) => {
    seen.push({ url, method: init.method, body: init.body, duplex: init.duplex });
    return new Response(null, { status: 204 });
  };
  const port = await listen(t, { fetchImpl });
  const response = await fetch(`http://127.0.0.1:${port}/v1/files/file_1`, { method: 'DELETE' });
  assert.equal(response.status, 204);
  assert.deepEqual(seen, [
    {
      url: 'https://api.anthropic.com/v1/files/file_1',
      method: 'DELETE',
      body: undefined,
      duplex: undefined,
    },
  ]);
});

test('paths outside /v1 go to Anthropic raw, while /multi routes keep their own gate', async (t) => {
  const urls: string[] = [];
  const fetchImpl: GatewayFetch = async (url) => {
    urls.push(url);
    return new Response('ok');
  };
  const port = await listen(t, { fetchImpl });
  for (const route of ['/api/hello', '/api/claude_cli/bootstrap?x=1', '/']) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${route}`)).status, 200);
  }
  assert.deepEqual(urls, [
    'https://api.anthropic.com/api/hello',
    'https://api.anthropic.com/api/claude_cli/bootstrap?x=1',
    'https://api.anthropic.com/',
  ]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/multi/other`)).status, 403);
  assert.equal(urls.length, 3);
});

test('the caller own base URL receives native traffic', async (t) => {
  const urls: string[] = [];
  const fetchImpl: GatewayFetch = async (url) => {
    urls.push(url);
    return new Response('ok');
  };
  const port = await listen(t, { fetchImpl, anthropicBaseUrl: 'https://corp.example/anthropic/' });
  await fetch(`http://127.0.0.1:${port}/v1/files?a=1`);
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'x-multi-gateway-token': TOKEN },
    body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
  });
  assert.deepEqual(urls, [
    'https://corp.example/anthropic/v1/files?a=1',
    'https://corp.example/anthropic/v1/messages',
  ]);
});

test('the client encoding preference reaches Anthropic only for encodings fetch decodes', async (t) => {
  const encodings: (string | undefined)[] = [];
  const fetchImpl: GatewayFetch = async (_url, init) => {
    encodings.push(init.headers['accept-encoding']);
    return new Response('ok');
  };
  const port = await listen(t, { fetchImpl });
  for (const value of ['gzip, br;q=0.5, zstd', 'zstd', 'identity']) {
    await fetch(`http://127.0.0.1:${port}/v1/files`, { headers: { 'accept-encoding': value } });
  }
  assert.deepEqual(encodings, ['gzip, br', 'identity', 'identity']);
});

test('a gateway failure on a native request is reported as a diagnostic, not hidden', async (t) => {
  const events: GatewayEvent[] = [];
  const fetchImpl: GatewayFetch = async () => {
    throw new TypeError('fetch failed');
  };
  const port = await listen(t, { fetchImpl, onEvent: (event) => events.push(event) });
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'x-multi-gateway-token': TOKEN },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
    }),
  );
  assert(
    events.some((event) => event.route === 'anthropic' && event.diagnostic === 'fetch failed'),
  );
});

test('a long observed tool_use line stops observation with a diagnostic and passes through', async (t) => {
  const events: GatewayEvent[] = [];
  const big = 'x'.repeat(9 * 1024 * 1024);
  const body = `event: content_block_delta\ndata: ${big}\n`;
  const fetchImpl: GatewayFetch = async () =>
    new Response(`${body}\nevent: ping\ndata: {}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  const port = await listen(t, { fetchImpl, onEvent: (event) => events.push(event) });
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'x-multi-gateway-token': TOKEN },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      stream: true,
      tools: [{ name: 'Write', input_schema: { type: 'object' } }],
      messages: [],
    }),
  });
  assert.equal((await response.text()).length, body.length + '\nevent: ping\ndata: {}\n\n'.length);
  assert(events.some((event) => event.diagnostic?.includes('exceeds 8 MiB')));
});

test('a non-streamed provider reply that outlasts the delay sends headers and keeps alive', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keepalive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake', account_id: 'fake' } }),
  );
  const events = [
    { type: 'response.created', response: { id: 'r', usage: null } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, delta: 'Done' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
    },
    {
      type: 'response.completed',
      response: { id: 'r', usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  const fetchImpl: GatewayFetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
  };
  const port = await listen(t, { fetchImpl, authFile, jsonKeepAliveMs: 50 });
  const request = JSON.stringify({
    model: 'multi/openai/gpt-6-luna',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const started = Date.now();
  const timing = await new Promise<{ headersAt: number; text: string; status?: number }>(
    (resolve, reject) => {
      const req = http.request(
        {
          port,
          host: '127.0.0.1',
          path: '/v1/messages',
          method: 'POST',
          headers: { 'x-multi-gateway-token': TOKEN },
        },
        (res) => {
          const headersAt = Date.now() - started;
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve({ headersAt, text, status: res.statusCode }));
        },
      );
      req.on('error', reject);
      req.end(request);
    },
  );
  assert.equal(timing.status, 200);
  assert(timing.headersAt < 250, `headers came after ${timing.headersAt} ms`);
  assert(timing.text.startsWith(' '), 'leading JSON whitespace');
  assert.equal(JSON.parse(timing.text).content[0].text, 'Done');
});

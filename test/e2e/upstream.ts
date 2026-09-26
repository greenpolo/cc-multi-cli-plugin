import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { writeReply } from './protocols.ts';
import type { FakeServer, NativeInvocation, Provider, Scenario, UpstreamRequest } from './types.ts';

async function readBody(req: IncomingMessage) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw;
}

export async function startUpstreams(scenario: Scenario): Promise<FakeServer> {
  const requests: UpstreamRequest[] = [];
  const nativeInvocations: NativeInvocation[] = [];
  const errors: string[] = [];
  const counters = new Map<string, number>();
  const next = (name: string) => {
    const index = counters.get(name) ?? 0;
    counters.set(name, index + 1);
    return index;
  };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/native') {
      const invocation = JSON.parse(raw) as NativeInvocation;
      nativeInvocations.push(invocation);
      const script = scenario.native?.[invocation.name as 'agy' | 'grok' | 'codex'];
      if (!script) {
        throw new Error(`Unscripted native executable: ${invocation.name}`);
      }
      const reply = await script(invocation, next(invocation.name));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      return;
    }
    const provider = url.pathname.split('/')[1] as Provider;
    const request: UpstreamRequest = {
      provider,
      path: url.pathname.replace(`/${provider}`, '') + url.search,
      raw,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : {},
      aborted: false,
    };
    requests.push(request);
    res.on('close', () => {
      request.aborted = !res.writableFinished;
    });
    if (request.path.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":10}');
      return;
    }
    if (provider === 'openai' && request.path.startsWith('/backend-api/codex/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[]}');
      return;
    }
    const script = scenario.upstream?.[provider];
    if (!script) {
      throw new Error(`Unscripted upstream: ${provider} ${request.path}`);
    }
    await writeReply(res, request, await script(request, next(provider)));
  }
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      errors.push(String(error));
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No fake upstream address');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    nativeInvocations,
    errors,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

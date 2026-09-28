import http from 'node:http';
import type { TestContext } from 'node:test';

/** Local transport seam until Reply supports raw SSE. Only already redirected
 * loopback Responses requests are intercepted; the harness origin denylist stays intact. */
export async function rawUpstream(t: TestContext, body: string) {
  const requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
    }
    requests.push(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No raw upstream address');
  }
  const source = `const original = globalThis.fetch; globalThis.fetch = (input, init) => { const u = new URL(input instanceof Request ? input.url : input); return original(u.hostname === '127.0.0.1' && u.pathname === '/openai/backend-api/codex/responses' ? 'http://127.0.0.1:${address.port}' : input, init); };`;
  return {
    requests,
    env: { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(source)}` },
  };
}

export function sse(type: string, body: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
}

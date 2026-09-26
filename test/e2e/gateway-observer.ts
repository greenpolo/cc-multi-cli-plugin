import http, { type IncomingHttpHeaders, type Server } from 'node:http';

function replay(server: Server, url: string, headers: IncomingHttpHeaders, raw: string) {
  const address = server.address();
  if (!address || typeof address === 'string') {
    return;
  }
  const request = http.request(
    {
      hostname: '127.0.0.1',
      port: address.port,
      path: url,
      method: 'POST',
      headers: { ...headers, 'x-e2e-replay': '1' },
    },
    (response) => {
      response.resume();
      response.on('end', () => {
        process.stderr.write(`E2E_NATIVE_REPLAY=${response.statusCode}\n`);
      });
    },
  );
  request.on('error', () => {
    process.stderr.write('E2E_NATIVE_REPLAY=failed\n');
  });
  request.end(raw);
}

/** Passive wire observation; optional duplicate transport delivery tests durable replay. */
export function observeGateway(server: Server) {
  let replayed = false;
  server.on('request', (req, res) => {
    if (!req.url?.startsWith('/v1/messages?') || req.headers['x-e2e-replay']) {
      return;
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk;
    });
    req.on('end', () => {
      process.stderr.write(
        `E2E_GATEWAY_REQUEST=${JSON.stringify({ raw, headers: req.headers })}\n`,
      );
      const body = JSON.parse(raw) as { model?: string };
      if (
        replayed ||
        process.env.MULTI_E2E_REPLAY_NATIVE !== '1' ||
        !body.model?.startsWith('multi/antigravity/')
      ) {
        return;
      }
      replayed = true;
      res.once('finish', () => {
        replay(server, req.url ?? '/v1/messages', req.headers, raw);
      });
    });
  });
}

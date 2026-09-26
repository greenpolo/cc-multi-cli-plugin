import http from 'node:http';

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

export async function fakeUpstream() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ path: req.url, body });
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/v1/messages/count_tokens') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    if (pathname !== '/v1/messages') {
      res.writeHead(404).end();
      return;
    }
    const hasResult = body.messages?.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool_result'),
    );
    const block = hasResult
      ? { type: 'text', text: 'Hermetic scenario complete.' }
      : {
          type: 'tool_use',
          id: 'toolu_e2e',
          name: 'Bash',
          input: { command: 'echo hi > out.txt', description: 'Write fixture output' },
        };
    const stop = hasResult ? 'end_turn' : 'tool_use';
    const message = {
      id: 'msg_e2e',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, data) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message });
    event('content_block_start', {
      index: 0,
      content_block: hasResult ? { type: 'text', text: '' } : { ...block, input: {} },
    });
    event('content_block_delta', {
      index: 0,
      delta: hasResult
        ? { type: 'text_delta', text: block.text }
        : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
    });
    event('content_block_stop', { index: 0 });
    event('message_delta', {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 20 },
    });
    event('message_stop', {});
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

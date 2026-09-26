import type { ServerResponse } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import type { Reply, ReplyWriter, UpstreamRequest } from './types.ts';

function event(res: ServerResponse, type: string, body: object) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
}
async function delay(reply: Reply) {
  if (reply.delayMs) {
    await setTimeout(reply.delayMs);
  }
}

const anthropic: ReplyWriter = async (res, request, reply) => {
  const tool = reply.tool;
  const message = {
    id: 'msg_e2e',
    type: 'message',
    role: 'assistant',
    model: request.body.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  };
  event(res, 'message_start', { message });
  event(res, 'content_block_start', {
    index: 0,
    content_block: tool
      ? { type: 'tool_use', id: tool.id ?? 'toolu_e2e', name: tool.name, input: {} }
      : { type: 'text', text: '' },
  });
  await delay(reply);
  event(res, 'content_block_delta', {
    index: 0,
    delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) }
      : { type: 'text_delta', text: reply.text ?? 'E2E complete.' },
  });
  event(res, 'content_block_stop', { index: 0 });
  event(res, 'message_delta', {
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  event(res, 'message_stop', {});
};

const openai: ReplyWriter = async (res, _request, reply) => {
  const tool = reply.tool;
  const item = tool
    ? {
        id: 'fc_e2e',
        type: 'function_call',
        call_id: tool.id ?? 'call_e2e',
        name: tool.name,
        arguments: JSON.stringify(tool.input),
        status: 'completed',
      }
    : {
        id: 'item_e2e',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: reply.text ?? 'E2E complete.', annotations: [] }],
      };
  const response = {
    id: 'resp_e2e',
    object: 'response',
    status: 'in_progress',
    output: [],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
  event(res, 'response.created', { response });
  await delay(reply);
  event(res, 'response.output_item.added', { output_index: 0, item });
  event(res, 'response.output_item.done', { output_index: 0, item });
  event(res, 'response.completed', {
    response: { ...response, status: 'completed', output: [item] },
  });
};

const zen: ReplyWriter = async (res, request, reply) => {
  if (request.path.includes('/messages')) {
    await anthropic(res, request, reply);
    return;
  }
  await delay(reply);
  const tool = reply.tool;
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: tool.id ?? 'call_e2e',
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.input) },
          },
        ],
      }
    : { content: reply.text ?? 'E2E complete.' };
  const chunk = (content: object) =>
    res.write(
      `data: ${JSON.stringify({ id: 'chat_e2e', object: 'chat.completion.chunk', choices: [{ index: 0, ...content }] })}\n\n`,
    );
  chunk({ delta, finish_reason: null });
  chunk({ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' });
  res.write('data: [DONE]\n\n');
};

export async function writeReply(res: ServerResponse, request: UpstreamRequest, reply: Reply) {
  if (reply.json !== undefined || (reply.status && reply.status !== 200)) {
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.json ?? { error: 'Scripted upstream failure' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  await { anthropic, openai, zen }[request.provider](res, request, reply);
  res.end();
}

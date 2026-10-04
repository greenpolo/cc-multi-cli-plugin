import { randomUUID } from 'node:crypto';
import { wellFormed } from './display-rows.ts';
import type {
  ContentBlock,
  Emit,
  MessagesRequest,
  MessagesResponse,
  RequestMessage,
} from './messages.ts';
import { safeguardResults } from './safeguards.ts';

const HANDBACK_TOOL = 'SubagentHandback';
const enforcement = /^\[handback-send-enforce\]/;
const fallback = 'Native run finished.';

export function handbackOffered(body: MessagesRequest): boolean {
  if (!wellFormed(body)) {
    return false;
  }
  return body.tools?.some((tool) => tool.name === HANDBACK_TOOL) ?? false;
}

function blocks(message: RequestMessage | undefined): ContentBlock[] {
  if (!message) {
    return [];
  }
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content;
}

/** These are Claude's delivery protocol, never native-harness input. */
export function handbackRequestKind(body: MessagesRequest): 'result' | 'enforce' | undefined {
  if (!wellFormed(body)) {
    return undefined;
  }
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  if (last?.role !== 'user') {
    return undefined;
  }
  const content = blocks(last);
  if (
    content.some(
      (block) =>
        block.type === 'text' &&
        typeof block.text === 'string' &&
        enforcement.test(block.text.trimStart()),
    )
  ) {
    return 'enforce';
  }
  const ids = new Set(
    messages.flatMap((message) =>
      message.role === 'assistant'
        ? blocks(message).flatMap((block) =>
            block.type === 'tool_use' && block.name === HANDBACK_TOOL && block.id ? [block.id] : [],
          )
        : [],
    ),
  );
  if (
    content.length > 0 &&
    content.every(
      (block) =>
        block.type === 'tool_result' &&
        block.tool_use_id !== undefined &&
        ids.has(block.tool_use_id),
    )
  ) {
    return 'result';
  }
  return undefined;
}

function joined(messages: RequestMessage[]): RequestMessage[] {
  const result: RequestMessage[] = [];
  for (const message of messages) {
    const content = blocks(message);
    if (!content.length) {
      continue;
    }
    const previous = result.at(-1);
    if (previous?.role === message.role) {
      result[result.length - 1] = {
        role: message.role,
        content: [...blocks(previous), ...content],
      };
    } else {
      result.push({ role: message.role, content });
    }
  }
  return result;
}

/** Strip gateway handbacks and their results before continuation or rewind checks. */
export function withoutHarnessHandback(body: MessagesRequest): MessagesRequest {
  if (!wellFormed(body)) {
    return body;
  }
  const messages = body.messages ?? [];
  const tools = body.tools?.filter((tool) => tool.name !== HANDBACK_TOOL);
  const ids = new Set(
    messages.flatMap((message) =>
      blocks(message).flatMap((block) =>
        block.type === 'tool_use' && block.name === HANDBACK_TOOL && block.id ? [block.id] : [],
      ),
    ),
  );
  if (!ids.size) {
    return tools?.length === body.tools?.length ? body : { ...body, tools };
  }
  const cleaned = messages.map((message) => ({
    ...message,
    content: cleanHandbackMessage(message, ids),
  }));
  return { ...body, ...(body.tools ? { tools } : {}), messages: joined(cleaned) };
}

function cleanHandbackMessage(message: RequestMessage, ids: ReadonlySet<string>): ContentBlock[] {
  const original = blocks(message);
  const content = original.filter(
    (block) =>
      !(block.type === 'tool_use' && block.name === HANDBACK_TOOL) &&
      !(
        block.type === 'tool_result' &&
        block.tool_use_id !== undefined &&
        ids.has(block.tool_use_id)
      ),
  );
  // An empty native answer still has a delivered report. Keep an assistant
  // anchor so the next user message is a continuation, not a fresh prompt.
  if (
    message.role === 'assistant' &&
    !content.length &&
    original.some((block) => block.type === 'tool_use' && block.name === HANDBACK_TOOL)
  ) {
    return [{ type: 'text', text: fallback }];
  }
  return content;
}

export function recordedReport(response: MessagesResponse | undefined): string | undefined {
  if (!response) {
    return undefined;
  }
  // With rows, only the deferred follow-up is the worker's final answer.
  const text =
    response.multi_followup ??
    response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  return text || fallback;
}

export function withHandback(
  response: MessagesResponse,
  report: string,
  safeguards: unknown,
): MessagesResponse {
  // This call delivers the gateway's own reply; it is not a replay of a native tool event.
  const block = {
    type: 'tool_use' as const,
    id: `toolu_multi_handback_${randomUUID().replaceAll('-', '')}`,
    name: HANDBACK_TOOL,
    input: { message: report || fallback },
  };
  const content = [...response.content, block];
  const existing = response.safeguard_results ?? safeguardResults(safeguards, content, 'native');
  const safeguard_results = existing
    ? ([
        {
          type: 'dangerous_tool_use' as const,
          status: {
            type: 'available' as const,
            tool_uses: {
              ...existing[0].status.tool_uses,
              [block.id]: { type: 'evaluated' as const, outcome: 'not_flagged' as const },
            },
          },
        },
      ] as const)
    : undefined;
  return {
    ...response,
    content,
    stop_reason: 'tool_use',
    ...(safeguard_results
      ? { safeguard_results: [...safeguard_results] as MessagesResponse['safeguard_results'] }
      : {}),
  };
}

/** Append the delivery block after streamed text, before the terminal event. */
export function emitHandback(emit: Emit, response: MessagesResponse): void {
  const block = response.content.at(-1);
  if (block?.type !== 'tool_use' || block.name !== HANDBACK_TOOL) {
    return;
  }
  const index = response.content.length - 1;
  emit('content_block_start', { index, content_block: { ...block, input: {} } });
  emit('content_block_delta', {
    index,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
  });
  emit('content_block_stop', { index });
}

import type { ContentBlock, RequestMessage } from './messages.ts';
import { callId, toolName } from './tools.ts';

const IMAGE_MEDIA_TYPES: readonly unknown[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

export type NormalizedContent =
  | { type: 'input_text' | 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' }
  | { type: 'input_file'; filename: string; file_data: string };

export type NormalizedConversationItem<R = never> =
  | { role: 'user' | 'assistant' | 'developer'; content: NormalizedContent[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string | NormalizedContent[] }
  | R;

export type AssistantReasoningDecoder<R> = (block: ContentBlock) => R | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentBlocks(value: unknown): ContentBlock[] {
  if (typeof value === 'string') {
    return [{ type: 'text', text: value }];
  }
  if (!Array.isArray(value)) {
    throw new Error('Expected text or content blocks');
  }
  for (const block of value) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      throw new Error('Invalid content block');
    }
    for (const key of ['id', 'name', 'tool_use_id', 'signature', 'title', 'tool_name']) {
      if (block[key] !== undefined && typeof block[key] !== 'string') {
        throw new Error(`Invalid content field: ${key}`);
      }
    }
    if (block.is_error !== undefined && typeof block.is_error !== 'boolean') {
      throw new Error('Invalid tool result error flag');
    }
  }
  return value;
}

export function textContent(value: unknown): string {
  return contentBlocks(value)
    .map((block) => {
      if (block.type !== 'text' || typeof block.text !== 'string') {
        throw new Error(`Unsupported text content: ${block.type}`);
      }
      return block.text;
    })
    .join('\n');
}

function imageInput(block: ContentBlock): NormalizedContent {
  const source = block.source;
  let imageUrl: string;
  if (source?.type === 'base64') {
    if (
      !IMAGE_MEDIA_TYPES.includes(source.media_type) ||
      typeof source.data !== 'string' ||
      !source.data ||
      Buffer.from(source.data, 'base64').toString('base64') !== source.data
    ) {
      throw new Error('Invalid base64 image source');
    }
    imageUrl = `data:${source.media_type};base64,${source.data}`;
  } else if (source?.type === 'url') {
    let url: URL;
    if (typeof source.url !== 'string') {
      throw new Error('Invalid image URL');
    }
    try {
      url = new URL(source.url);
    } catch {
      throw new Error('Invalid image URL');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Invalid image URL');
    }
    imageUrl = source.url;
  } else {
    throw new Error('Unsupported image source');
  }
  return { type: 'input_image', image_url: imageUrl, detail: 'auto' };
}

function documentInput(block: ContentBlock): NormalizedContent[] {
  const source = block.source;
  const title = block.title ? `Document: ${block.title}\n` : '';
  if (
    source?.type === 'text' &&
    source.media_type === 'text/plain' &&
    typeof source.data === 'string'
  ) {
    return [{ type: 'input_text', text: title + source.data }];
  }
  if (
    source?.type !== 'base64' ||
    source.media_type !== 'application/pdf' ||
    typeof source.data !== 'string' ||
    !source.data ||
    Buffer.from(source.data, 'base64').toString('base64') !== source.data
  ) {
    throw new Error('Unsupported document: use base64 PDF or text/plain');
  }
  return [
    {
      type: 'input_file',
      filename: 'document.pdf',
      file_data: `data:application/pdf;base64,${source.data}`,
    },
  ];
}

function toolOutput(block: ContentBlock): string | NormalizedContent[] {
  const content = contentBlocks(block.content ?? '');
  const prefix = block.is_error ? 'Tool error:\n' : '';
  if (!content.some((item) => ['image', 'document', 'tool_reference'].includes(item.type))) {
    return prefix + textContent(content);
  }
  return [
    ...(prefix ? [{ type: 'input_text' as const, text: prefix }] : []),
    ...content.flatMap((item): NormalizedContent[] => {
      if (item.type === 'image') {
        return [imageInput(item)];
      }
      if (item.type === 'document') {
        return documentInput(item);
      }
      if (item.type === 'tool_reference' && item.tool_name) {
        return [{ type: 'input_text', text: `Available tool: ${toolName(item.tool_name)}` }];
      }
      return [{ type: 'input_text', text: textContent([item]) }];
    }),
  ];
}

function assistantInput<R>(
  block: ContentBlock,
  decodeReasoning: AssistantReasoningDecoder<R>,
): NormalizedConversationItem<R>[] {
  if (block.type === 'tool_use') {
    if (!block.id || !block.name || !isRecord(block.input)) {
      throw new Error('Invalid tool_use');
    }
    return [
      {
        type: 'function_call',
        call_id: callId(block.id),
        name: toolName(block.name),
        arguments: JSON.stringify(block.input),
      },
    ];
  }
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    const reasoning = decodeReasoning(block);
    return reasoning === undefined ? [] : [reasoning];
  }
  throw new Error(`Unsupported native worker content: ${block.type}`);
}

function userInput<R>(block: ContentBlock): NormalizedConversationItem<R>[] {
  if (block.type === 'image') {
    return [{ role: 'user', content: [imageInput(block)] }];
  }
  if (block.type === 'document') {
    return [{ role: 'user', content: documentInput(block) }];
  }
  if (block.type === 'tool_result') {
    if (!block.tool_use_id) {
      throw new Error('Missing tool result ID');
    }
    return [
      {
        type: 'function_call_output',
        call_id: callId(block.tool_use_id),
        output: toolOutput(block),
      },
    ];
  }
  throw new Error(`Unsupported native worker content: ${block.type}`);
}

function normalizeMessage<R>(
  message: RequestMessage,
  decodeReasoning: AssistantReasoningDecoder<R>,
): NormalizedConversationItem<R>[] {
  const role = message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'system') {
    throw new Error('Unsupported message role');
  }
  return contentBlocks(message.content).flatMap((block): NormalizedConversationItem<R>[] => {
    if (block.type === 'text') {
      return [
        {
          role: role === 'system' ? 'developer' : role,
          content: [
            {
              type: role === 'assistant' ? 'output_text' : 'input_text',
              text: textContent([block]),
            },
          ],
        },
      ];
    }
    if (role === 'assistant') {
      return assistantInput(block, decodeReasoning);
    }
    if (role === 'user') {
      return userInput(block);
    }
    throw new Error(`Unsupported native worker content: ${block.type}`);
  });
}

export function normalizeConversation<R = never>(
  messages: RequestMessage[] | undefined,
  decodeReasoning: AssistantReasoningDecoder<R> = () => undefined,
): NormalizedConversationItem<R>[] {
  if (!Array.isArray(messages)) {
    throw new Error('messages must be an array');
  }
  return messages.flatMap((message) => normalizeMessage(message, decodeReasoning));
}

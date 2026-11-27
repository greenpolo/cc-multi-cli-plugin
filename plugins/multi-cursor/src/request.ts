import type { SDKUserMessage } from '@cursor/sdk';
import {
  type NormalizedConversationItem,
  normalizeConversation,
  textContent,
} from '../../multi-core/src/gateway/conversation.ts';
import { isDirectToolAvailable } from '../../multi-core/src/gateway/direct-tools.ts';
import { withoutClaudeCatalogues } from '../../multi-core/src/gateway/harness-prompt.ts';
import type { MessagesRequest } from '../../multi-core/src/gateway/messages.ts';
import { isRecord } from '../../multi-core/src/gateway/record.ts';
import { estimateTextTokens } from '../../multi-core/src/gateway/tokens.ts';

function validateControls(body: MessagesRequest) {
  if (
    body.output_config != null &&
    (typeof body.output_config !== 'object' || Array.isArray(body.output_config))
  ) {
    throw new Error('Invalid output_config');
  }
  if (body.output_config?.effort !== undefined && typeof body.output_config.effort !== 'string') {
    throw new Error('Invalid effort');
  }
  // A tool choice, an output schema and stop sequences have no Cursor SDK form; the run
  // goes ahead with Cursor's own automatic tools rather than being refused.
  if (
    body.tool_choice?.disable_parallel_tool_use !== undefined &&
    typeof body.tool_choice.disable_parallel_tool_use !== 'boolean'
  ) {
    throw new Error('Invalid parallel tool choice');
  }
  validateRequestShape(body);
}

function validateRequestShape(body: MessagesRequest) {
  if (
    body.stop_sequences !== undefined &&
    (!Array.isArray(body.stop_sequences) ||
      body.stop_sequences.some((sequence) => typeof sequence !== 'string' || !sequence.length))
  ) {
    throw new Error('Invalid stop sequences');
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error('tools must be an array');
  }
  for (const tool of body.tools ?? []) {
    if (!tool.defer_loading || (tool.name && isDirectToolAvailable(body, tool.name))) {
      validateTool(tool);
    }
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new Error('stream must be boolean');
  }
  validateThinking(body.thinking);
}

function validateTool(tool: NonNullable<MessagesRequest['tools']>[number]) {
  if (tool.type && tool.type !== 'custom') {
    throw new Error(`Unsupported server tool: ${tool.type}`);
  }
  if (typeof tool.name !== 'string' || !tool.name.trim() || !isRecord(tool.input_schema)) {
    throw new Error('Invalid function tool');
  }
  if (tool.description !== undefined && typeof tool.description !== 'string') {
    throw new Error('Invalid tool description');
  }
}

function validateThinking(thinking: MessagesRequest['thinking']) {
  if (thinking != null && !isRecord(thinking)) {
    throw new Error('Invalid thinking');
  }
  if (thinking && !['enabled', 'adaptive', 'disabled', 'auto'].includes(thinking.type)) {
    throw new Error('Unsupported thinking configuration');
  }
  const budget = thinking?.budget_tokens;
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) {
    throw new Error('Invalid thinking budget');
  }
}

/**
 * Claude's tool, skill, MCP and agent catalogues name capabilities Cursor cannot call, so
 * they are left out; a turn that held nothing else goes with them.
 */
function withoutCatalogues(items: NormalizedConversationItem[]): NormalizedConversationItem[] {
  return items.flatMap((item): NormalizedConversationItem[] => {
    if (!('content' in item)) {
      return [item];
    }
    const content = item.content.flatMap((part) => {
      if (part.type !== 'input_text' && part.type !== 'output_text') {
        return [part];
      }
      const text = withoutClaudeCatalogues(part.text);
      return text.trim() ? [{ ...part, text }] : [];
    });
    return content.length ? [{ ...item, content }] : [];
  });
}

export function prepareCursorRequest(body: MessagesRequest) {
  validateControls(body);
  // AgentOptions has no Messages max-token or sampling controls. Keep Claude's
  // required max_tokens accepted, but do not claim the SDK enforces it or samples.
  textContent(body.system ?? '');
  const normalized = withoutCatalogues(normalizeConversation(body.messages));
  const images: NonNullable<SDKUserMessage['images']> = [];
  const input = JSON.parse(JSON.stringify(normalized), (_key, value) => {
    if (value?.type === 'input_file') {
      // The SDK takes no PDF, so it is named rather than refusing the run.
      return { type: 'text', text: '[PDF attachment omitted: Cursor receives no PDF]' };
    }
    if (value?.type === 'input_image') {
      if (value.image_url.startsWith('data:')) {
        const [prefix, data] = value.image_url.split(',');
        images.push({ data, mimeType: prefix.slice(5).split(';')[0] });
      } else {
        images.push({ url: value.image_url });
      }
      return { type: 'text', text: `[Attached image ${images.length}]` };
    }
    return value;
  });
  const prompt: SDKUserMessage = {
    text: [
      'You are the Cursor coding agent displayed inside Claude Code. Use your native tools and permissions.',
      'The supplied conversation is context. Previously recorded actions are complete; never repeat them to reconstruct state.',
      'Continue after the final message.',
      JSON.stringify({ conversation: input }),
    ].join('\n'),
    ...(images.length ? { images } : {}),
  };
  // ponytail: SDK hidden envelope overhead and image expansion are unknown;
  // estimate the submitted prompt until SDK exposes context counting.
  const inputTokens = estimateTextTokens(prompt.text ?? '') + images.length * 4096;
  return { prompt, inputTokens };
}

import type { ContentBlock, MessagesRequest, RequestMessage } from './messages.ts';
import { estimateTextTokens } from './tokens.ts';

type PromptOptions = {
  /** The subject of every error message, for example `Grok`. */
  provider: string;
  preamble: string;
  stripCatalogues?: boolean;
  dropEmptyTurns?: boolean;
};

/**
 * Claude's system reminders carry two different kinds of block, and only one of
 * them is noise here. The catalogues — its deferred tools, MCP servers, skills and
 * subagent types — describe capabilities a native harness cannot call. Measured on
 * a live session they were 72,704 characters of a 95,852-character prompt whose
 * real message was 841, and they are dropped.
 *
 * Everything else is an instruction addressed to whoever answers the turn: the
 * project's CLAUDE.md and the user's own, Auto Mode notices, hook output and
 * recalled memories. A native CLI reads the repository's AGENTS.md for itself and
 * reaches none of the rest, so those blocks are forwarded. The filter names the
 * catalogues and keeps what it does not recognise: a renamed catalogue costs
 * tokens, while a renamed instruction block would cost the worker the rules it is
 * meant to follow.
 */
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const CATALOGUES: readonly RegExp[] = [
  /The following deferred tools are now available/i,
  /The following skills are available for use with the Skill tool/i,
  /Available agent types for the Agent tool/i,
  /#+ MCP Server Instructions/,
];

/** The forwarded prompt: catalogues out, instructions in. */
function withoutClaudeCatalogues(text: string): string {
  return text.replace(SYSTEM_REMINDER, (block) =>
    CATALOGUES.some((catalogue) => catalogue.test(block)) ? '' : block,
  );
}

function blockText(
  block: ContentBlock,
  allowReasoning: boolean,
  role: string,
  options: PromptOptions,
): string {
  if (block.type === 'text' && typeof block.text === 'string') {
    return options.stripCatalogues ? withoutClaudeCatalogues(block.text) : block.text;
  }
  if (block.type === 'tool_use') {
    return toolUseText(block, role, options);
  }
  if (block.type === 'tool_result') {
    return toolResultText(block, role, options);
  }
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    if (allowReasoning) {
      return '';
    }
    throw new Error(`${options.provider} CLI does not accept provider-owned reasoning content`);
  }
  throw new Error(`${options.provider} CLI does not support content block ${block.type}`);
}

function toolUseText(block: ContentBlock, role: string, options: PromptOptions): string {
  if (role !== 'assistant' || typeof block.id !== 'string' || typeof block.name !== 'string') {
    throw new Error(`${options.provider} CLI requires assistant tool_use blocks`);
  }
  return `[tool use ${block.name}] ${JSON.stringify(block.input ?? {})}`;
}

function toolResultText(block: ContentBlock, role: string, options: PromptOptions): string {
  if (role !== 'user' || typeof block.tool_use_id !== 'string' || block.content === undefined) {
    throw new Error(`${options.provider} CLI requires tool_result content`);
  }
  const text = contentText(block.content, options, false, 'tool_result');
  return `[tool result ${block.tool_use_id}] ${text}`;
}

function contentText(
  content: unknown,
  options: PromptOptions,
  allowReasoning = false,
  role = 'user',
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
          throw new Error(`${options.provider} CLI requires valid content blocks`);
        }
        return blockText(block as ContentBlock, allowReasoning, role, options);
      })
      .join('');
  }
  if (content === undefined) {
    return '';
  }
  throw new Error(`${options.provider} CLI requires string or array content`);
}

function messageText(message: RequestMessage, options: PromptOptions): string {
  if (!['user', 'assistant', 'system'].includes(message.role)) {
    throw new Error(`${options.provider} CLI does not support ${message.role} messages`);
  }
  const content = contentText(message.content, options, message.role === 'assistant', message.role);
  if (options.dropEmptyTurns && !content.trim()) {
    // A turn that carried nothing but catalogues has no content left to forward.
    return '';
  }
  return `${message.role}: ${content}`;
}

/**
 * Convert Messages context into one authenticated native prompt: a fixed preamble
 * plus the conversation text. A native CLI applies its own system prompt and reads
 * the repository's AGENTS.md itself, so Claude's `system` is never forwarded, and
 * native tools stay in the CLI.
 */
export function prepareNativePrompt(
  body: MessagesRequest,
  options: PromptOptions,
): { prompt: string; inputTokens: number } {
  validateNativeMessages(body, options.provider);
  const turns = (body.messages ?? []).map((message) => messageText(message, options));
  const conversation = (options.dropEmptyTurns ? turns.filter(Boolean) : turns).join('\n');
  if (options.dropEmptyTurns && !conversation) {
    throw new Error(`${options.provider} requires a conversation with content`);
  }
  const prompt = [options.preamble, conversation].filter(Boolean).join('\n\n');
  return { prompt, inputTokens: estimateTextTokens(prompt) };
}

export function validateNativeMessages(body: MessagesRequest, provider: string): void {
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new Error(`${provider} requires a conversation`);
  }
  if (
    body.messages.some(
      (message) =>
        !message ||
        typeof message !== 'object' ||
        !['user', 'assistant', 'system'].includes(message.role) ||
        (typeof message.content !== 'string' && !Array.isArray(message.content)),
    )
  ) {
    throw new Error(`${provider} requires valid conversation messages`);
  }
  if (body.output_config?.format || body.output_format) {
    // A native CLI's own schema flag covers a whole single-turn run; it cannot
    // carry a Messages schema through a native tool loop.
    throw new Error(`${provider} CLI does not support strict Messages output schemas`);
  }
  if (body.tool_choice && body.tool_choice.type !== 'auto') {
    throw new Error(`${provider} CLI only supports its native automatic tools`);
  }
  if (
    body.thinking !== undefined &&
    (!body.thinking ||
      typeof body.thinking !== 'object' ||
      !['enabled', 'disabled', 'adaptive'].includes(body.thinking.type) ||
      (body.thinking.budget_tokens !== undefined &&
        (!Number.isSafeInteger(body.thinking.budget_tokens) || body.thinking.budget_tokens < 0)))
  ) {
    throw new Error(`${provider} requires a valid thinking configuration`);
  }
  if (body.stop_sequences?.length) {
    throw new Error(`${provider} CLI does not support Messages stop sequences`);
  }
}

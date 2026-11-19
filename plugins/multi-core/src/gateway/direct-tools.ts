import type { MessagesRequest } from './messages.ts';
import { isRecord } from './record.ts';

/**
 * Claude Code's advisor (`advisorModel`) is an Anthropic server tool, such as
 * `{ type: 'advisor_20260301', name: 'advisor', model }`. Only Anthropic can run it, so
 * routes to other providers leave it out instead of refusing the whole request.
 */
export function isAnthropicAdvisorTool(tool: unknown): boolean {
  return isRecord(tool) && typeof tool.type === 'string' && tool.type.startsWith('advisor_');
}

/** Keep deferred schemas out of provider requests until Claude has discovered or used them. */
export function isDirectToolAvailable(body: MessagesRequest, name: string): boolean {
  if (body.tool_choice?.type === 'tool' && body.tool_choice.name === name) {
    return true;
  }
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (blockHasToolName(block, name)) {
        return true;
      }
    }
  }
  return false;
}

function blockHasToolName(
  block: { type: string; name?: string; tool_name?: string; content?: unknown },
  name: string,
): boolean {
  if (
    (block.type === 'tool_reference' && block.tool_name === name) ||
    (block.type === 'tool_use' && block.name === name)
  ) {
    return true;
  }
  if (!Array.isArray(block.content)) {
    return false;
  }
  return block.content.some(
    (child) =>
      typeof child === 'object' &&
      child !== null &&
      !Array.isArray(child) &&
      blockHasToolName(
        child as { type: string; name?: string; tool_name?: string; content?: unknown },
        name,
      ),
  );
}

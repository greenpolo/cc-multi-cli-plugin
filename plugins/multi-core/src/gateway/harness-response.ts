import { randomUUID } from 'node:crypto';
import type { HarnessEvent } from './harness-exchange.ts';
import type { Emit, MessagesResponse } from './messages.ts';
import type { ModDisplayEvent } from './mod-bridge.ts';

const maxOutputBytes = 32 * 1024 * 1024;

/**
 * The provider's usage record, mapped into one vocabulary at the call site.
 * `cache_read_tokens` and `cache_read_input_tokens` stay provider-side.
 */
export type HarnessUsageFields = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
  reasoning?: number;
  total?: number;
};

/**
 * The assistant answer a native run produces. Native activity is displayed, never
 * replayed: text blocks and mod display rows are the only things constructible
 * here, so an observed external tool call can never become an executable Claude
 * tool call.
 */
export class HarnessResponse {
  private readonly response: MessagesResponse;
  private readonly emit: Emit;
  private readonly terminalEvents: HarnessEvent[] = [];
  private readonly multiBlock: boolean;
  private activeTextIndex: number | undefined;
  private bytes = 0;

  constructor(
    model: string,
    inputTokens: number,
    emit: Emit,
    options: { multiBlock?: boolean } = {},
  ) {
    this.emit = emit;
    this.multiBlock = options.multiBlock ?? false;
    this.response = {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    };
    emit('message_start', { message: structuredClone(this.response) });
  }

  text(value: string): void {
    if (!value) {
      return;
    }
    this.bytes += Buffer.byteLength(value);
    if (this.bytes > maxOutputBytes) {
      throw new Error('Native run exceeded the 32 MiB output limit');
    }
    if (this.activeTextIndex === undefined) {
      this.activeTextIndex = this.response.content.length;
      this.response.content.push({ type: 'text', text: '' });
      this.emit('content_block_start', {
        index: this.activeTextIndex,
        content_block: { type: 'text', text: '' },
      });
    }
    const block = this.response.content[this.activeTextIndex];
    if (block.type === 'text') {
      block.text += value;
    }
    this.emit('content_block_delta', {
      index: this.activeTextIndex,
      delta: { type: 'text_delta', text: value },
    });
  }

  /** A progress row rendered by the mod; it carries no executable Claude tool. */
  displayRow(event: ModDisplayEvent): void {
    if (!this.multiBlock) {
      throw new Error('This harness response does not emit native display rows');
    }
    if (this.activeTextIndex !== undefined) {
      this.emit('content_block_stop', { index: this.activeTextIndex });
      this.activeTextIndex = undefined;
    }
    const index = this.response.content.length;
    this.response.content.push({
      type: 'tool_use',
      id: event.toolUseId,
      name: event.tool,
      input: event.input,
    });
    this.emit('content_block_start', {
      index,
      content_block: { type: 'tool_use', id: event.toolUseId, name: event.tool, input: {} },
    });
    this.emit('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(event.input) },
    });
    this.emit('content_block_stop', { index });
  }

  finish(usage: HarnessUsageFields | undefined, model?: string, effort?: string): MessagesResponse {
    if (this.activeTextIndex !== undefined) {
      this.emit('content_block_stop', { index: this.activeTextIndex });
      this.activeTextIndex = undefined;
    }
    this.response.stop_reason = 'end_turn';
    const estimatedOutput = Math.ceil(JSON.stringify(this.response.content).length / 4);
    this.response.usage.input_tokens = usage?.input ?? this.response.usage.input_tokens;
    this.response.usage.output_tokens = usage?.output ?? estimatedOutput;
    if (usage?.cacheRead !== undefined) {
      this.response.usage.cache_read_input_tokens = usage.cacheRead;
    }
    if (usage?.cacheCreate !== undefined) {
      this.response.usage.cache_creation_input_tokens = usage.cacheCreate;
    }
    this.response.multi_usage = {
      source: usageSource(usage),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(usage?.reasoning === undefined ? {} : { reasoning_tokens: usage.reasoning }),
      ...(usage?.total === undefined ? {} : { total_tokens: usage.total }),
    };
    this.terminalEvents.push([
      'message_delta',
      { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: this.response.usage },
    ]);
    this.terminalEvents.push(['message_stop', {}]);
    return this.response;
  }

  /**
   * The terminal events are held back so they are emitted only after the turn is
   * durably recorded: a crash between the two would otherwise report a completed
   * turn no record remembers.
   */
  takeTerminalEvents(): HarnessEvent[] {
    return this.terminalEvents.splice(0);
  }
}

/** Estimates are never presented as billed usage. */
export function usageSource(
  usage: HarnessUsageFields | undefined,
): NonNullable<MessagesResponse['multi_usage']>['source'] {
  if (usage === undefined) {
    return 'estimate';
  }
  return usage.input !== undefined && usage.output !== undefined ? 'provider' : 'mixed';
}

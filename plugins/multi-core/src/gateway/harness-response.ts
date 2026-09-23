import { randomUUID } from 'node:crypto';
import type { DisplayToolUse } from './display-rows.ts';
import type { HarnessEvent } from './harness-exchange.ts';
import type { Emit, MessagesResponse } from './messages.ts';

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
 * The assistant answer a native run produces: text, and a display row for each
 * finished native action. A row is a tool_use block only the gateway can issue
 * (`DisplayRows.issue`), named after the native tool and answered by the Multi mod
 * with the native output; an observed action is never replayed or executed.
 *
 * The engine runs a reply's rows and then asks for the turn's next message, and
 * the last message of a turn is what a worker's parent receives. So once a row
 * is written, later text is held back as `multi_followup`, which the gateway
 * answers that next request with, instead of being streamed here.
 */
export class HarnessResponse {
  private readonly response: MessagesResponse;
  private readonly emit: Emit;
  private readonly terminalEvents: HarnessEvent[] = [];
  private activeTextIndex: number | undefined;
  private bytes = 0;
  private rows = false;
  private deferred = '';

  constructor(model: string, inputTokens: number, emit: Emit) {
    this.emit = emit;
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
    if (this.rows) {
      this.deferred += value;
      return;
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

  /** Writes one display row; the text after it waits for the follow-up message. */
  displayRow(block: DisplayToolUse): void {
    this.closeText();
    const index = this.response.content.length;
    this.response.content.push(block);
    this.emit('content_block_start', {
      index,
      content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
    });
    this.emit('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
    });
    this.emit('content_block_stop', { index });
    this.rows = true;
  }

  private closeText() {
    if (this.activeTextIndex !== undefined) {
      this.emit('content_block_stop', { index: this.activeTextIndex });
      this.activeTextIndex = undefined;
    }
  }

  finish(usage: HarnessUsageFields | undefined, model?: string, effort?: string): MessagesResponse {
    this.closeText();
    this.response.stop_reason = 'end_turn';
    if (this.rows) {
      this.response.multi_followup = this.deferred;
    }
    const estimatedOutput = Math.ceil(
      (JSON.stringify(this.response.content).length + this.deferred.length) / 4,
    );
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

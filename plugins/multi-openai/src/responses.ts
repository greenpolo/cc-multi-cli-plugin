import { isDeepStrictEqual } from 'node:util';
import {
  type NormalizedContent,
  normalizeConversation,
  textContent,
} from '../../multi-core/src/gateway/conversation.ts';
import { isDirectToolAvailable } from '../../multi-core/src/gateway/direct-tools.ts';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
  ResponseContentBlock,
  StopReason,
} from '../../multi-core/src/gateway/messages.ts';
import { callId, toolName } from '../../multi-core/src/gateway/tools.ts';

// Anthropic Messages <-> OpenAI Responses, for native Claude Code workers.
const SIGNATURE_PREFIX = 'multi-openai:';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type Effort = (typeof EFFORTS)[number];

// ---------------------------------------------------------------------------
// OpenAI Responses, as the gateway sends and reads them.
// ---------------------------------------------------------------------------

export type ResponsesInputContent = NormalizedContent;

export type ResponsesInputItem =
  | { role: 'user' | 'assistant' | 'developer'; content: ResponsesInputContent[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string | ResponsesInputContent[] }
  | { type: 'reasoning'; id?: string; encrypted_content: string; summary: unknown };

interface ResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: unknown;
  strict: boolean;
}

type ResponsesToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; name?: string };

export interface ResponsesRequest {
  model: string;
  prompt_cache_key?: string;
  instructions: string;
  input: ResponsesInputItem[];
  tools: ResponsesTool[];
  text?: { format: { type: 'json_schema'; name: string; schema: unknown; strict: boolean } };
  tool_choice: ResponsesToolChoice;
  parallel_tool_calls: boolean;
  reasoning: { effort: Effort; summary: 'auto' };
  include: string[];
  store: boolean;
  stream: boolean;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

interface ResponsesResponse {
  id: string;
  status?: string;
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage | null;
  incomplete_details?: { reason?: string };
  error?: { message?: string };
}

/** Part of a completed `message` output item. */
interface ResponsesOutputContent {
  type: string;
  text?: string;
  refusal?: string;
}

/** The output items this gateway understands; any other `type` is rejected. */
type ResponsesOutputItem = (
  | { type: 'message'; content?: ResponsesOutputContent[] }
  | { type: 'function_call'; call_id?: string; name?: string; arguments?: string }
  | { type: 'reasoning'; encrypted_content?: string | null; summary?: unknown }
) & { id?: string };

/** Streamed events the translation acts on. Any other `type` is ignored, exactly
 *  as an unrecognised event was before it had a name here. */
type ResponseStreamEvent =
  | { type: 'response.created'; response: ResponsesResponse }
  | { type: 'response.output_item.added'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.output_item.done'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.output_text.delta'; output_index: number; delta: string }
  | { type: 'response.refusal.delta'; output_index: number; delta: string }
  | { type: 'response.function_call_arguments.delta'; output_index: number; delta: string }
  | { type: 'response.reasoning_summary_text.delta'; output_index: number; delta: string }
  | { type: 'response.completed'; response: ResponsesResponse }
  | { type: 'response.done'; response: ResponsesResponse }
  | { type: 'response.incomplete'; response: ResponsesResponse }
  | { type: 'response.failed'; response?: Pick<ResponsesResponse, 'error'>; message?: string }
  | { type: 'error'; response?: Pick<ResponsesResponse, 'error'>; message?: string };

/** Provider reasoning state, round-tripped through an opaque Claude signature. */
interface ReasoningState {
  type: 'reasoning';
  id?: string;
  encrypted_content: string;
  summary?: unknown;
}

// Boundary guards: JSON.parse and the provider stream hand us `unknown`.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOutputItem(value: unknown, done: boolean): value is ResponsesOutputItem {
  if (
    !isRecord(value) ||
    typeof value.type !== 'string' ||
    (value.id !== undefined && typeof value.id !== 'string')
  ) {
    return false;
  }
  if (value.type === 'function_call') {
    return ['call_id', 'name', 'arguments'].every((key) =>
      value[key] === undefined ? !done : typeof value[key] === 'string',
    );
  }
  if (value.type === 'message') {
    return (
      value.content === undefined ||
      (Array.isArray(value.content) &&
        value.content.every(
          (part) =>
            isRecord(part) &&
            (part.type === 'output_text'
              ? typeof part.text === 'string'
              : part.type === 'refusal' && typeof part.refusal === 'string'),
        ))
    );
  }
  if (value.type === 'reasoning') {
    return (
      (value.encrypted_content === undefined ||
        (!done && value.encrypted_content === null) ||
        typeof value.encrypted_content === 'string') &&
      (value.summary === undefined ||
        (Array.isArray(value.summary) &&
          value.summary.every(
            (part) =>
              isRecord(part) && part.type === 'summary_text' && typeof part.text === 'string',
          )))
    );
  }
  return false;
}

function validResponse(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return false;
  }
  if (
    value.output !== undefined &&
    (!Array.isArray(value.output) || !value.output.every((item) => isOutputItem(item, true)))
  ) {
    return false;
  }
  if (value.status !== undefined && typeof value.status !== 'string') {
    return false;
  }
  if (value.usage == null) {
    return true;
  }
  if (!isRecord(value.usage)) {
    return false;
  }
  const count = (v: unknown) =>
    v === undefined || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
  const usage = value.usage;
  return (
    count(usage.input_tokens) &&
    count(usage.output_tokens) &&
    (usage.input_tokens_details === undefined ||
      (isRecord(usage.input_tokens_details) &&
        count(usage.input_tokens_details.cached_tokens) &&
        count(usage.input_tokens_details.cache_write_tokens)))
  );
}

/** Ignore new event types; validate every known field before narrowing JSON. */
function isStreamEvent(value: unknown): value is ResponseStreamEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Malformed OpenAI stream event');
  }
  const indexed = Number.isSafeInteger(value.output_index) && Number(value.output_index) >= 0;
  let valid: boolean;
  switch (value.type) {
    case 'response.created':
    case 'response.completed':
    case 'response.done':
    case 'response.incomplete':
      valid = validResponse(value.response);
      break;
    case 'response.output_item.added':
    case 'response.output_item.done':
      valid = indexed && isOutputItem(value.item, value.type.endsWith('.done'));
      break;
    case 'response.output_text.delta':
    case 'response.refusal.delta':
    case 'response.function_call_arguments.delta':
    case 'response.reasoning_summary_text.delta':
      valid = indexed && typeof value.delta === 'string';
      break;
    case 'response.failed':
    case 'error':
      valid =
        (value.message === undefined || typeof value.message === 'string') &&
        (value.response === undefined ||
          (isRecord(value.response) &&
            (value.response.error === undefined ||
              (isRecord(value.response.error) &&
                (value.response.error.message === undefined ||
                  typeof value.response.error.message === 'string')))));
      break;
    default:
      return false;
  }
  if (!valid) {
    throw new Error(`OpenAI sent a malformed ${value.type} event`);
  }
  return true;
}

function isReasoningState(value: unknown): value is ReasoningState {
  return (
    isRecord(value) &&
    isOutputItem(value, true) &&
    value.type === 'reasoning' &&
    typeof value.encrypted_content === 'string' &&
    value.encrypted_content.length > 0
  );
}

function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

// Only rewrite Claude-bound history when it contains our provider's opaque state.
export function forAnthropic(body: MessagesRequest): MessagesRequest {
  let changed = false;
  const messages = body.messages
    ?.map((message) => {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) {
        return message;
      }
      const content = message.content.filter((block) => {
        const foreign =
          block.type === 'thinking' &&
          [SIGNATURE_PREFIX, 'multi-zen-responses:', 'multi-zen-chat:'].some((prefix) =>
            block.signature?.startsWith(prefix),
          );
        changed ||= Boolean(foreign);
        return !foreign;
      });
      return { ...message, content };
    })
    .filter((message) => !Array.isArray(message.content) || message.content.length);
  return changed ? { ...body, messages } : body;
}

function validateRequestOptions(body: MessagesRequest) {
  if (
    body.stop_sequences !== undefined &&
    (!Array.isArray(body.stop_sequences) ||
      body.stop_sequences.some((s) => typeof s !== 'string' || !s.length))
  ) {
    throw new Error('Invalid stop sequences');
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error('tools must be an array');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new Error('stream must be boolean');
  }
  for (const key of ['output_config', 'output_format', 'thinking', 'tool_choice'] as const) {
    if (body[key] != null && !isRecord(body[key])) {
      throw new Error(`Invalid ${key}`);
    }
  }
}

function outputFormat(body: MessagesRequest) {
  const format = body.output_config?.format ?? body.output_format;
  if (
    format != null &&
    (format.type !== 'json_schema' ||
      !format.schema ||
      typeof format.schema !== 'object' ||
      Array.isArray(format.schema))
  ) {
    throw new Error('Unsupported output format: expected json_schema with an object schema');
  }
  return format;
}

function inputTool(tool: unknown): ResponsesTool {
  if (!isRecord(tool)) {
    throw new Error('Invalid tool');
  }
  if (tool.type && tool.type !== 'custom') {
    throw new Error(`Unsupported server tool: ${tool.type}`);
  }
  if (typeof tool.name !== 'string' || !tool.name.trim() || !isRecord(tool.input_schema)) {
    throw new Error('Invalid function tool');
  }
  if (tool.description !== undefined && typeof tool.description !== 'string') {
    throw new Error('Invalid tool description');
  }
  return {
    type: 'function',
    name: toolName(tool.name),
    description: tool.description ?? '',
    parameters: tool.input_schema,
    strict: false,
  };
}

function toolChoice(
  choice: MessagesRequest['tool_choice'],
  tools: ResponsesTool[],
): ResponsesToolChoice {
  const wanted = choice?.type ?? 'auto';
  if (!['auto', 'any', 'none', 'tool'].includes(wanted)) {
    throw new Error('Unsupported tool choice');
  }
  const name = choice?.name;
  if (
    wanted === 'tool' &&
    (typeof name !== 'string' || !tools.some((tool) => tool.name === toolName(name)))
  ) {
    throw new Error('Named tool choice must reference a declared tool');
  }
  if (
    choice?.disable_parallel_tool_use !== undefined &&
    typeof choice.disable_parallel_tool_use !== 'boolean'
  ) {
    throw new Error('Invalid parallel tool choice');
  }
  switch (wanted) {
    case 'tool':
      if (typeof name !== 'string') {
        throw new Error('Missing named tool choice');
      }
      return { type: 'function', name: toolName(name) };
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    default:
      return 'auto';
  }
}

function budgetEffort(thinking: MessagesRequest['thinking']): Effort {
  if (thinking?.type === 'disabled') {
    return 'low';
  }
  const budget = thinking?.budget_tokens;
  if (budget === undefined) {
    return 'medium';
  }
  if (budget <= 1024) {
    return 'low';
  }
  if (budget <= 8192) {
    return 'medium';
  }
  if (budget <= 24576) {
    return 'high';
  }
  return 'xhigh';
}

function reasoningEffort(body: MessagesRequest): Effort {
  const thinking = body.thinking;
  if (thinking && !['enabled', 'adaptive', 'disabled', 'auto'].includes(thinking.type)) {
    throw new Error('Unsupported thinking configuration');
  }
  const budget = thinking?.budget_tokens;
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) {
    throw new Error('Invalid thinking budget');
  }
  const effort = body.output_config?.effort ?? budgetEffort(thinking);
  if (!isEffort(effort)) {
    throw new Error(`Unsupported reasoning effort: ${effort}`);
  }
  return effort;
}

function decodeReasoning(signaturePrefix: string) {
  return (block: { type: string; signature?: string }): ResponsesInputItem | undefined => {
    if (block.type === 'redacted_thinking' || !block.signature?.startsWith(signaturePrefix)) {
      return undefined;
    }
    const item: unknown = JSON.parse(
      Buffer.from(block.signature.slice(signaturePrefix.length), 'base64url').toString(),
    );
    if (!isReasoningState(item)) {
      throw new Error('Invalid reasoning state');
    }
    return {
      type: 'reasoning',
      id: item.id,
      encrypted_content: item.encrypted_content,
      summary: item.summary ?? [],
    };
  };
}

export function toResponses(
  body: MessagesRequest,
  model: string,
  signaturePrefix = SIGNATURE_PREFIX,
): ResponsesRequest {
  validateRequestOptions(body);
  const format = outputFormat(body);
  const input = normalizeConversation(body.messages, decodeReasoning(signaturePrefix));
  // Claude's tool-search flow keeps deferred schemas out of the initial model
  // request. A loaded tool is resent without defer_loading on the next turn.
  const tools = (body.tools ?? [])
    .filter(
      (tool) =>
        !isDeferredTool(tool) ||
        (typeof tool.name === 'string' && isDirectToolAvailable(body, tool.name)),
    )
    .map(inputTool);
  const choice = toolChoice(body.tool_choice, tools);
  const effort = reasoningEffort(body);
  return {
    model,
    instructions: textContent(body.system ?? ''),
    input,
    tools,
    ...(format
      ? {
          text: {
            format: {
              type: 'json_schema' as const,
              name: 'claude_output',
              schema: format.schema,
              strict: true,
            },
          },
        }
      : {}),
    tool_choice: choice,
    parallel_tool_calls: !body.tool_choice?.disable_parallel_tool_use,
    reasoning: { effort, summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    // Codex subscriptions require store:false and streaming; max_tokens is unsupported.
    store: false,
    stream: true,
  };
}

function isDeferredTool(tool: unknown): boolean {
  return isRecord(tool) && tool.defer_loading === true;
}

export async function* readSse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  let dataBytes = 0;
  let totalBytes = 0;
  const addData = (line: string) => {
    dataBytes += Buffer.byteLength(line);
    if (dataBytes > 8 * 1024 * 1024) {
      throw new Error('OpenAI SSE event exceeds 8 MiB');
    }
    data.push(line);
  };
  const parse = (): unknown => {
    const value = data.join('\n');
    if (Buffer.byteLength(value) > 8 * 1024 * 1024) {
      throw new Error('OpenAI SSE event exceeds 8 MiB');
    }
    data = [];
    dataBytes = 0;
    return value && value !== '[DONE]' ? JSON.parse(value) : null;
  };
  const consumeLine = (line: string): unknown => {
    if (!line) {
      return parse();
    }
    if (line.startsWith('data:')) {
      addData(line.slice(5).replace(/^ /, ''));
    }
    return null;
  };
  for await (const chunk of stream) {
    totalBytes += chunk.byteLength;
    if (totalBytes > 32 * 1024 * 1024) {
      throw new Error('OpenAI response exceeds 32 MiB');
    }
    pending += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(pending) > 8 * 1024 * 1024) {
      throw new Error('OpenAI SSE buffer exceeds 8 MiB');
    }
    for (let index = pending.indexOf('\n'); index !== -1; index = pending.indexOf('\n')) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      const event = consumeLine(line);
      if (event) {
        yield event;
      }
    }
  }
  pending += decoder.decode();
  if (pending.startsWith('data:')) {
    addData(pending.slice(5).trimStart());
  }
  const event = parse();
  if (event) {
    yield event;
  }
}

interface OutputSlot {
  item: ResponsesOutputItem;
  text: string;
  arguments: string;
  done: boolean;
  block?: ResponseContentBlock;
  index?: number;
  emitted: number;
}

function finalOutputItem(
  previous: ResponsesOutputItem,
  item: ResponsesOutputItem,
): ResponsesOutputItem {
  if (previous.type !== item.type) {
    throw new Error('OpenAI output item changed type');
  }
  const before = [previous.id];
  const after = [item.id];
  if (previous.type === 'function_call' && item.type === 'function_call') {
    before.push(previous.call_id, previous.name);
    after.push(item.call_id, item.name);
  }
  if (before.some((value, index) => value && after[index] && value !== after[index])) {
    throw new Error('OpenAI output item changed identity');
  }
  // Prefer final encrypted state; retain an earlier snapshot only when omitted.
  if (previous.type === 'reasoning' && item.type === 'reasoning') {
    return { ...previous, ...item };
  }
  return { ...item, id: item.id ?? previous.id };
}

function outputValue(item: ResponsesOutputItem): unknown {
  switch (item.type) {
    case 'message':
      return item.content;
    case 'function_call':
      return [item.call_id, item.name, item.arguments];
    case 'reasoning':
      // The provider may rotate encrypted_content between output_item.done and
      // response.completed while preserving the visible reasoning summary.
      // Already emitted signatures retain the completed item snapshot; opaque
      // ciphertext is not a stable identity field for terminal reconciliation.
      return [item.summary ?? []];
  }
}

export interface ResponseOptions {
  toolNames?: ReadonlyMap<string, string>;
  stopSequences?: readonly string[];
  signaturePrefix?: string;
  requireUsage?: boolean;
  /** Local input estimate for message_start; the provider only reports usage at completion. */
  inputTokens?: number;
}

/** Assembles one ordered Claude response from possibly interleaved OpenAI output items. */
class ResponseStream {
  private content: ResponseContentBlock[] = [];
  private slots = new Map<number, OutputSlot>();
  private message?: MessagesResponse;
  private cursor = 0;
  private stopped: string | null = null;
  completed = false;
  private model: string;
  private emit: Emit;
  private options: ResponseOptions;

  constructor(model: string, emit: Emit, options: ResponseOptions) {
    this.model = model;
    this.emit = emit;
    this.options = options;
  }

  result(): MessagesResponse {
    if (!this.completed || !this.message) {
      throw new Error('OpenAI stream ended before completion');
    }
    return this.message;
  }

  accept(event: ResponseStreamEvent) {
    switch (event.type) {
      case 'response.created':
        this.start(event.response);
        return;
      case 'response.failed':
      case 'error':
        throw new Error(event.message ?? event.response?.error?.message ?? 'OpenAI stream failed');
      case 'response.completed':
      case 'response.done':
      case 'response.incomplete':
        this.complete(event);
        return;
      default:
        if (!this.message) {
          throw new Error('OpenAI stream omitted response.created');
        }
        this.update(event);
        this.drain();
        if (this.stopped) {
          this.finish('stop_sequence');
        }
    }
  }

  private start(response: ResponsesResponse) {
    if (this.message) {
      return;
    }
    this.message = {
      id: response.id,
      type: 'message',
      role: 'assistant',
      model: this.model,
      content: this.content,
      stop_reason: null,
      stop_sequence: null,
      // Claude Code reads the input count from message_start; the terminal
      // message_delta replaces this estimate with the provider's real usage.
      usage: { input_tokens: this.options.inputTokens ?? 0, output_tokens: 0 },
    };
    this.emit('message_start', { message: { ...this.message, content: [] } });
  }

  private finish(stopReason: StopReason, usage?: ResponsesUsage | null) {
    const message = this.message;
    if (!message) {
      throw new Error('OpenAI stream omitted response.created');
    }
    const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
    const written = usage?.input_tokens_details?.cache_write_tokens ?? 0;
    message.usage = {
      input_tokens: Math.max(0, (usage?.input_tokens ?? 0) - cached - written),
      output_tokens: usage?.output_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: written,
    };
    message.multi_usage = {
      source: usage ? 'provider' : 'unavailable',
      ...(usage ? { total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) } : {}),
      model: this.model,
    };
    message.stop_reason = stopReason;
    message.stop_sequence = this.stopped;
    this.emit('message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: this.stopped },
      usage: message.usage,
    });
    this.emit('message_stop', {});
    this.completed = true;
  }

  private complete(
    event: Extract<
      ResponseStreamEvent,
      { type: 'response.completed' | 'response.incomplete' | 'response.done' }
    >,
  ) {
    if (
      this.options.requireUsage &&
      (event.response.usage?.input_tokens === undefined ||
        event.response.usage.output_tokens === undefined)
    ) {
      throw new Error('Provider completed without token usage; cost accounting is unavailable');
    }
    this.start(event.response);
    if (event.response.status && !['completed', 'incomplete'].includes(event.response.status)) {
      throw new Error(`OpenAI terminal response has status ${event.response.status}`);
    }
    const incomplete =
      event.type === 'response.incomplete' || event.response.status === 'incomplete';
    if (incomplete && event.response.incomplete_details?.reason !== 'max_output_tokens') {
      throw new Error(
        `OpenAI response incomplete: ${event.response.incomplete_details?.reason ?? 'unknown'}`,
      );
    }
    this.reconcile(event.response.output);
    if ([...this.slots.values()].some((slot) => !slot.done)) {
      throw new Error('OpenAI completed with an unfinished content block');
    }
    this.drain();
    if (this.stopped) {
      this.finish('stop_sequence', event.response.usage);
      return;
    }
    if (!this.content.length || this.cursor !== this.slots.size) {
      throw new Error('OpenAI completed with missing output');
    }
    let stopReason: StopReason = this.content.some((block) => block.type === 'tool_use')
      ? 'tool_use'
      : 'end_turn';
    if (incomplete) {
      stopReason = 'max_tokens';
    }
    this.finish(stopReason, event.response.usage);
  }

  private reconcile(output?: ResponsesOutputItem[]) {
    // Some streams omit the redundant output array or send []; their finished
    // incremental items remain authoritative. A populated array must agree.
    if (!output?.length) {
      return;
    }
    if ([...this.slots.keys()].some((index) => index >= output.length)) {
      throw new Error('OpenAI terminal output omitted a streamed item');
    }
    for (const [index, item] of output.entries()) {
      const slot = this.slots.get(index) ?? this.addSlot(index, item);
      this.finishItem(slot, item);
    }
  }

  private addSlot(index: number, item: ResponsesOutputItem): OutputSlot {
    if (this.slots.has(index)) {
      throw new Error('Duplicate OpenAI output item');
    }
    const slot = { item, text: '', arguments: '', done: false, emitted: 0 };
    this.slots.set(index, slot);
    return slot;
  }

  private update(event: Extract<ResponseStreamEvent, { output_index: number }>) {
    if (event.type === 'response.output_item.added') {
      this.addSlot(event.output_index, event.item);
      return;
    }
    if (event.type === 'response.output_item.done') {
      const slot =
        this.slots.get(event.output_index) ?? this.addSlot(event.output_index, event.item);
      this.finishItem(slot, event.item);
      return;
    }
    const slot = this.slots.get(event.output_index);
    if (!slot || slot.done) {
      throw new Error('OpenAI event without an active output item');
    }
    if (event.type === 'response.function_call_arguments.delta') {
      if (slot.item.type !== 'function_call') {
        throw new Error('Arguments without function call');
      }
      slot.arguments += event.delta;
    } else {
      const thinking = event.type === 'response.reasoning_summary_text.delta';
      if (slot.item.type !== (thinking ? 'reasoning' : 'message')) {
        throw new Error('OpenAI delta has the wrong output type');
      }
      slot.text += event.delta;
    }
  }

  private finishItem(slot: OutputSlot, item: ResponsesOutputItem) {
    const final = finalOutputItem(slot.item, item);
    if (slot.done) {
      if (!isDeepStrictEqual(outputValue(slot.item), outputValue(final))) {
        throw new Error('OpenAI terminal output changed a completed item');
      }
      return;
    }
    if (final.type === 'message') {
      const text = (final.content ?? [])
        .map((block) => (block.type === 'refusal' ? block.refusal : block.text))
        .join('');
      if (!text.startsWith(slot.text)) {
        throw new Error('OpenAI text changed after streaming');
      }
      slot.text = text;
    } else if (final.type === 'function_call') {
      if (!final.arguments?.startsWith(slot.arguments)) {
        throw new Error('OpenAI function arguments changed after streaming');
      }
      slot.arguments = final.arguments;
    } else if (!slot.text && Array.isArray(final.summary)) {
      slot.text = final.summary.map((part) => (part as { text: string }).text).join('\n');
    }
    slot.item = final;
    slot.done = true;
  }

  private createBlock(slot: OutputSlot): ResponseContentBlock {
    const item = slot.item;
    if (item.type === 'reasoning') {
      return { type: 'thinking', thinking: '', signature: '' };
    }
    if (item.type === 'message') {
      return { type: 'text', text: '' };
    }
    if (!item.call_id || !item.name || typeof item.arguments !== 'string') {
      throw new Error('Incomplete function call');
    }
    if (slot.arguments && slot.arguments !== item.arguments) {
      throw new Error('OpenAI function arguments changed after streaming');
    }
    const input: unknown = JSON.parse(item.arguments);
    if (!isRecord(input)) {
      throw new Error('OpenAI function arguments must be an object');
    }
    const name = this.options.toolNames?.get(item.name) ?? item.name;
    if (this.options.toolNames && !this.options.toolNames.has(item.name)) {
      throw new Error('OpenAI returned an undeclared tool');
    }
    const id = callId(item.call_id);
    if (this.content.some((block) => block.type === 'tool_use' && block.id === id)) {
      throw new Error('OpenAI repeated a tool call ID');
    }
    return { type: 'tool_use', id, name, input };
  }

  private beginBlock(slot: OutputSlot) {
    if (slot.block && slot.index !== undefined) {
      return { block: slot.block, index: slot.index };
    }
    const block = this.createBlock(slot);
    const index = this.content.length;
    slot.block = block;
    slot.index = index;
    this.content.push(block);
    this.emit('content_block_start', {
      index,
      content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block },
    });
    return { block, index };
  }

  private textLimit(slot: OutputSlot): number {
    let matchAt = Infinity;
    for (const stop of this.options.stopSequences ?? []) {
      const at = slot.text.indexOf(stop);
      if (at >= 0 && at < matchAt) {
        matchAt = at;
        this.stopped = stop;
      }
    }
    if (this.stopped) {
      return matchAt;
    }
    if (slot.done) {
      return slot.text.length;
    }
    return prefixSafeLength(slot.text, this.options.stopSequences ?? []);
  }

  private writeBlock(slot: OutputSlot, block: ResponseContentBlock, index: number) {
    if (block.type === 'tool_use') {
      this.emit('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
      return;
    }
    const limit = block.type === 'text' ? this.textLimit(slot) : slot.text.length;
    const text = slot.text.slice(slot.emitted, limit);
    if (text) {
      this.emit('content_block_delta', {
        index,
        delta:
          block.type === 'text'
            ? { type: 'text_delta', text }
            : { type: 'thinking_delta', thinking: text },
      });
    }
    slot.emitted = limit;
    if (block.type === 'text') {
      block.text = slot.text.slice(0, limit);
    } else {
      block.thinking = slot.text.slice(0, limit);
    }
  }

  private closeBlock(slot: OutputSlot, block: ResponseContentBlock, index: number) {
    if (slot.item.type === 'reasoning' && block.type === 'thinking') {
      if (!isReasoningState(slot.item)) {
        throw new Error('OpenAI omitted encrypted reasoning state');
      }
      block.signature =
        (this.options.signaturePrefix ?? SIGNATURE_PREFIX) +
        Buffer.from(JSON.stringify(slot.item)).toString('base64url');
      this.emit('content_block_delta', {
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      });
    }
    this.emit('content_block_stop', { index });
  }

  private drain() {
    while (this.slots.has(this.cursor) && !this.stopped) {
      const slot = this.slots.get(this.cursor);
      if (!slot) {
        return;
      }
      if (slot.item.type === 'function_call' && !slot.done) {
        return;
      }
      const { block, index } = this.beginBlock(slot);
      this.writeBlock(slot, block, index);
      if (!slot.done && !this.stopped) {
        return;
      }
      this.closeBlock(slot, block, index);
      this.cursor++;
    }
  }
}

/** Hold suffixes that might become a stop sequence in a later text delta. */
export function prefixSafeLength(text: string, stops: readonly string[]): number {
  let limit = text.length;
  for (const stop of stops) {
    for (let length = 1; length < stop.length; length++) {
      if (text.endsWith(stop.slice(0, length))) {
        limit = Math.min(limit, text.length - length);
      }
    }
  }
  return limit;
}

export async function fromResponses(
  stream: AsyncIterable<Uint8Array>,
  model: string,
  emit: Emit = () => {},
  options: ResponseOptions = {},
): Promise<MessagesResponse> {
  const response = new ResponseStream(model, emit, options);
  for await (const event of readSse(stream)) {
    if (!isStreamEvent(event)) {
      continue;
    }
    response.accept(event);
    if (response.completed) {
      break;
    }
  }
  return response.result();
}

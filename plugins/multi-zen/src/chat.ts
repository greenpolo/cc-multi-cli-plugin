import { isDirectToolAvailable } from '../../multi-core/src/gateway/direct-tools.ts';
import type {
  ContentBlock,
  Emit,
  MessagesRequest,
  MessagesResponse,
  ResponseContentBlock,
  StopReason,
} from '../../multi-core/src/gateway/messages.ts';
import { safeguardResults } from '../../multi-core/src/gateway/safeguards.ts';
import { callId, toolName } from '../../multi-core/src/gateway/tools.ts';
import { prefixSafeLength, readSse } from '../../multi-openai/src/responses.ts';

const SIGNATURE_PREFIX = 'multi-zen-chat:';
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  parallel_tool_calls?: boolean;
  stream: true;
  stream_options: { include_usage: true };
  stop?: string[];
  max_tokens?: number;
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; schema: unknown; strict: true };
  };
}

interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContent[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: ChatToolCall[];
      reasoning_content?: string;
    }
  | { role: 'tool'; tool_call_id: string; content: string | ChatContent[] };

interface ChatContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatUsage {
  prompt_tokens?: number;
  cached_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ChatDelta {
  role?: unknown;
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: unknown;
}

interface ChatEvent {
  id?: unknown;
  choices?: unknown;
  usage?: unknown;
  error?: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function blocks(value: unknown): ContentBlock[] {
  if (typeof value === 'string') {
    return [{ type: 'text', text: value }];
  }
  if (!Array.isArray(value)) {
    throw new Error('Expected text or content blocks');
  }
  for (const block of value) {
    if (!record(block) || typeof block.type !== 'string') {
      throw new Error('Invalid content block');
    }
  }
  return value as ContentBlock[];
}

function text(value: unknown): string {
  return blocks(value)
    .map((block) => {
      if (block.type !== 'text' || typeof block.text !== 'string') {
        throw new Error(`Unsupported content block: ${block.type}`);
      }
      return block.text;
    })
    .join('\n');
}

function image(block: ContentBlock): ChatContent {
  const source = block.source;
  if (source?.type === 'url' && typeof source.url === 'string') {
    try {
      const parsed = new URL(source.url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error();
      }
    } catch {
      throw new Error('Invalid image URL');
    }
    return { type: 'image_url', image_url: { url: source.url } };
  }
  if (
    source?.type === 'base64' &&
    typeof source.media_type === 'string' &&
    IMAGE_MEDIA_TYPES.has(source.media_type) &&
    typeof source.data === 'string' &&
    source.data.length > 0 &&
    Buffer.from(source.data, 'base64').toString('base64') === source.data
  ) {
    return {
      type: 'image_url',
      image_url: { url: `data:${source.media_type};base64,${source.data}` },
    };
  }
  throw new Error('Unsupported image source');
}

function userContent(value: unknown): string | ChatContent[] {
  const content = blocks(value);
  if (content.every((block) => block.type === 'text')) {
    return content.map((block) => block.text as string).join('\n');
  }
  return content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: string(block.text, 'text content') };
    }
    if (block.type === 'image') {
      return image(block);
    }
    throw new Error(`Unsupported user content: ${block.type}`);
  });
}

function signature(model: string, reasoning: string): string {
  return `${SIGNATURE_PREFIX}${canonicalModel(model)}:${Buffer.from(JSON.stringify({ reasoning })).toString('base64url')}`;
}

function canonicalModel(model: string): string {
  return model.replace(/^multi\/zen\//, '');
}

function ownReasoning(model: string, block: ContentBlock): string | undefined {
  if (block.type !== 'thinking' || typeof block.signature !== 'string') {
    return undefined;
  }
  if (block.thinking !== undefined && typeof block.thinking !== 'string') {
    throw new Error('Invalid Zen reasoning content');
  }
  const prefix = `${SIGNATURE_PREFIX}${canonicalModel(model)}:`;
  if (!block.signature.startsWith(prefix)) {
    return undefined;
  }
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(block.signature.slice(prefix.length), 'base64url').toString(),
    );
    if (record(decoded) && typeof decoded.reasoning === 'string') {
      return decoded.reasoning;
    }
  } catch {
    throw new Error('Invalid Zen reasoning signature');
  }
  throw new Error('Invalid Zen reasoning signature');
}

function assistantMessage(message: ContentBlock[], model: string): ChatMessage | undefined {
  const content: string[] = [];
  const calls: ChatToolCall[] = [];
  let reasoning: string | undefined;
  let hasReasoning = false;
  for (const block of message) {
    const value = assistantText(block, model);
    if (value === undefined) {
      continue;
    }
    switch (value.kind) {
      case 'text':
        content.push(value.value);
        break;
      case 'tool':
        calls.push(value.value);
        break;
      case 'reasoning':
        reasoning = (reasoning ?? '') + value.value;
        hasReasoning = true;
        break;
    }
  }
  if (!content.length && !calls.length && !hasReasoning) {
    return undefined;
  }
  return {
    role: 'assistant',
    content: content.length ? content.join('') : null,
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(hasReasoning ? { reasoning_content: reasoning } : {}),
  };
}

function assistantText(
  block: ContentBlock,
  model: string,
):
  | { kind: 'text'; value: string }
  | { kind: 'tool'; value: ChatToolCall }
  | { kind: 'reasoning'; value: string }
  | undefined {
  if (block.type === 'text') {
    return { kind: 'text', value: string(block.text, 'assistant text') };
  }
  if (block.type === 'tool_use') {
    if (!block.id || !block.name || !record(block.input)) {
      throw new Error('Invalid tool_use');
    }
    return {
      kind: 'tool',
      value: {
        id: callId(block.id),
        type: 'function',
        function: { name: toolName(block.name), arguments: JSON.stringify(block.input) },
      },
    };
  }
  if (block.type === 'thinking') {
    const value = ownReasoning(model, block);
    return value === undefined ? undefined : { kind: 'reasoning', value };
  }
  if (block.type === 'redacted_thinking') {
    return undefined;
  }
  throw new Error(`Unsupported assistant content: ${block.type}`);
}

function toolResult(block: ContentBlock): string | ChatContent[] {
  if (block.type !== 'tool_result' || !block.tool_use_id) {
    throw new Error('Invalid tool result');
  }
  const content = blocks(block.content ?? '');
  if (content.every((item) => item.type === 'text' || item.type === 'tool_reference')) {
    return plainToolResult(content, block.is_error);
  }
  const result: ChatContent[] = [];
  if (block.is_error) {
    result.push({ type: 'text', text: 'Tool error:\n' });
  }
  for (const item of content) {
    if (item.type === 'text') {
      result.push({ type: 'text', text: string(item.text, 'tool result text') });
    } else if (item.type === 'image') {
      result.push(image(item));
    } else if (item.type === 'tool_reference' && item.tool_name) {
      result.push({ type: 'text', text: `Available tool: ${toolName(item.tool_name)}` });
    } else {
      throw new Error(`Unsupported tool result content: ${item.type}`);
    }
  }
  return result;
}

function plainToolResult(content: ContentBlock[], isError: boolean | undefined): string {
  const value = content
    .filter((item) => item.type === 'text')
    .map((item) => item.text as string)
    .join('\n');
  const references = content
    .filter((item) => item.type === 'tool_reference')
    .map((item) => {
      if (!item.tool_name) {
        throw new Error('Missing referenced tool name');
      }
      return `Available tool: ${toolName(item.tool_name)}`;
    });
  const combined = [...references, value].filter(Boolean).join('\n');
  return isError ? `Tool error:\n${combined}` : combined;
}

function toolChoice(body: MessagesRequest, tools: ChatTool[]) {
  const choice = body.tool_choice;
  if (!choice) {
    return undefined;
  }
  if (!['auto', 'any', 'none', 'tool'].includes(choice.type)) {
    throw new Error('Unsupported tool choice');
  }
  if (choice.type === 'tool') {
    const name = choice.name;
    if (typeof name !== 'string' || !tools.some((tool) => tool.function.name === toolName(name))) {
      throw new Error('Named tool choice must reference a declared tool');
    }
    return { type: 'function' as const, function: { name: toolName(name) } };
  }
  if (choice.type === 'any') {
    return 'required' as const;
  }
  return choice.type;
}

export function toChat(body: MessagesRequest, model: string): ChatRequest {
  if (!Array.isArray(body.messages)) {
    throw new Error('messages must be an array');
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error('tools must be an array');
  }
  const messages = chatMessages(body, model);
  // Claude's tool-search flow keeps deferred schemas out of the initial model
  // request. A loaded tool is resent without defer_loading on the next turn.
  const tools = chatTools(body);
  validateStops(body.stop_sequences);
  const result: ChatRequest = {
    model,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(body.tool_choice
      ? { tool_choice: toolChoice(body, tools) as ChatRequest['tool_choice'] }
      : {}),
    ...(body.tool_choice?.disable_parallel_tool_use !== undefined
      ? { parallel_tool_calls: !body.tool_choice.disable_parallel_tool_use }
      : {}),
    stream: true,
    stream_options: { include_usage: true },
    ...(body.stop_sequences?.length ? { stop: body.stop_sequences } : {}),
  };
  return requestOptions(body, result);
}

function chatMessages(body: MessagesRequest, model: string): ChatMessage[] {
  const messages: ChatMessage[] =
    body.system === undefined ? [] : [{ role: 'system', content: text(body.system) }];
  for (const message of body.messages ?? []) {
    const content = blocks(message.content);
    if (message.role === 'system') {
      messages.push({ role: 'system', content: text(content) });
    } else if (message.role === 'assistant') {
      const assistant = assistantMessage(content, model);
      if (assistant) {
        messages.push(assistant);
      }
    } else if (message.role === 'user') {
      lowerUserBlocks(content, messages);
    } else {
      throw new Error(`Unsupported message role: ${message.role}`);
    }
  }
  return messages;
}

function lowerUserBlocks(content: ContentBlock[], messages: ChatMessage[]) {
  for (const block of content) {
    if (block.type === 'tool_result') {
      if (!block.tool_use_id) {
        throw new Error('Missing tool result ID');
      }
      messages.push({
        role: 'tool',
        tool_call_id: callId(block.tool_use_id),
        content: toolResult(block),
      });
      continue;
    }
    const value = userContent([block]);
    const previous = messages.at(-1);
    if (
      typeof value === 'string' &&
      previous?.role === 'user' &&
      typeof previous.content === 'string'
    ) {
      previous.content += `\n${value}`;
    } else {
      messages.push({ role: 'user', content: value });
    }
  }
}

function chatTools(body: MessagesRequest): ChatTool[] {
  return (body.tools ?? [])
    .filter(
      (tool) =>
        !isDeferredTool(tool) ||
        (record(tool) && typeof tool.name === 'string' && isDirectToolAvailable(body, tool.name)),
    )
    .map(chatTool);
}

function isDeferredTool(tool: unknown): boolean {
  return record(tool) && tool.defer_loading === true;
}

function chatTool(tool: unknown): ChatTool {
  if (!record(tool) || (tool.type !== undefined && tool.type !== 'custom')) {
    throw new Error('Invalid tool');
  }
  if (typeof tool.name !== 'string' || !tool.name.trim() || !record(tool.input_schema)) {
    throw new Error('Invalid function tool');
  }
  if (tool.description !== undefined && typeof tool.description !== 'string') {
    throw new Error('Invalid tool description');
  }
  return {
    type: 'function',
    function: {
      name: toolName(tool.name),
      description: tool.description ?? '',
      parameters: tool.input_schema,
    },
  };
}

function validateStops(stops: unknown) {
  if (
    stops !== undefined &&
    (!Array.isArray(stops) || stops.some((stop) => typeof stop !== 'string' || !stop))
  ) {
    throw new Error('Invalid stop sequences');
  }
}

function requestOptions(body: MessagesRequest, result: ChatRequest): ChatRequest {
  const maxTokens = (body as MessagesRequest & { max_tokens?: unknown }).max_tokens;
  if (maxTokens !== undefined) {
    if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) <= 0) {
      throw new Error('Invalid max_tokens');
    }
    result.max_tokens = maxTokens as number;
  }
  const format = body.output_config?.format ?? body.output_format;
  if (format !== undefined) {
    if (format.type !== 'json_schema' || !record(format.schema)) {
      throw new Error('Unsupported output format');
    }
    result.response_format = {
      type: 'json_schema',
      json_schema: { name: 'claude_output', schema: format.schema, strict: true },
    };
  }
  return result;
}

function validUsage(value: unknown): value is ChatUsage {
  if (!record(value)) {
    return false;
  }
  if (!validUsageNumbers(value) || !validUsageDetails(value)) {
    return false;
  }
  const cached =
    usageNumber(value.prompt_tokens_details, 'cached_tokens') ??
    usageNumber(value, 'cached_tokens', 'cache_read_input_tokens');
  const written =
    usageNumber(value.prompt_tokens_details, 'cache_creation_input_tokens', 'cache_write_tokens') ??
    usageNumber(value, 'cache_creation_input_tokens');
  const prompt = usageNumber(value, 'prompt_tokens');
  return (
    prompt === undefined || ((cached ?? 0) <= prompt && (cached ?? 0) + (written ?? 0) <= prompt)
  );
}

function validUsageNumbers(value: Record<string, unknown>): boolean {
  return [
    'prompt_tokens',
    'cached_tokens',
    'completion_tokens',
    'total_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ].every((key) => {
    const item = value[key];
    return item === undefined || (Number.isSafeInteger(item) && Number(item) >= 0);
  });
}

function validUsageDetails(value: Record<string, unknown>): boolean {
  return ['prompt_tokens_details', 'completion_tokens_details'].every((key) => {
    const item = value[key];
    if (item === undefined || item === null) {
      return true;
    }
    return (
      record(item) &&
      Object.values(item).every((nested) => Number.isSafeInteger(nested) && Number(nested) >= 0)
    );
  });
}

function usageNumber(value: unknown, ...keys: string[]): number | undefined {
  if (!record(value)) {
    return undefined;
  }
  for (const key of keys) {
    if (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) {
      return Number(value[key]);
    }
  }
  return undefined;
}

function usage(value: ChatUsage): MessagesResponse['usage'] {
  const details = value.prompt_tokens_details;
  const cached =
    usageNumber(details, 'cached_tokens') ??
    value.cached_tokens ??
    value.cache_read_input_tokens ??
    0;
  const written =
    usageNumber(details, 'cache_creation_input_tokens', 'cache_write_tokens') ??
    value.cache_creation_input_tokens ??
    0;
  const input = value.prompt_tokens ?? 0;
  return {
    input_tokens: Math.max(0, input - cached - written),
    output_tokens: value.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
  };
}

interface ToolSlot {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
  closed: boolean;
}

function delta(value: unknown): ChatDelta {
  if (value === undefined || value === null) {
    return {};
  }
  if (!record(value)) {
    throw new Error('Malformed Zen Chat choice');
  }
  for (const key of ['content', 'reasoning_content']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(`Invalid ${key}`);
    }
  }
  if (
    value.tool_calls !== undefined &&
    value.tool_calls !== null &&
    !Array.isArray(value.tool_calls)
  ) {
    throw new Error('Invalid tool_calls');
  }
  return value as ChatDelta;
}

function finishReason(value: unknown): StopReason | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === 'stop') {
    return 'end_turn';
  }
  if (value === 'tool_calls' || value === 'function_call') {
    return 'tool_use';
  }
  if (value === 'length') {
    return 'max_tokens';
  }
  if (value === 'content_filter') {
    throw new Error('Zen Chat response was filtered');
  }
  throw new Error(`Unsupported Zen Chat finish reason: ${String(value)}`);
}

export interface ChatResponseOptions {
  safeguards?: unknown;
  toolNames?: ReadonlyMap<string, string>;
  stopSequences?: readonly string[];
  /** Local input estimate for message_start; Chat Completions report usage last. */
  inputTokens?: number;
}

class ChatAccumulator {
  readonly content: ResponseContentBlock[] = [];
  private readonly slots = new Map<number, ToolSlot>();
  private readonly model: string;
  private readonly emit: Emit;
  private readonly options: ChatResponseOptions;
  private id?: string;
  private reasoning = '';
  private textValue = '';
  private textEmitted = 0;
  private stoppedSequence: string | null = null;
  private usageValue?: ChatUsage;
  private stop?: StopReason;
  private started = false;
  private ended = false;
  /** The one content block currently open; blocks are strictly sequential. */
  private open?: { kind: 'text' | 'thinking'; index: number };

  constructor(model: string, emit: Emit, options: ChatResponseOptions) {
    this.model = model;
    this.emit = emit;
    this.options = options;
  }

  accept(value: unknown) {
    if (!record(value)) {
      throw new Error('Malformed Zen Chat event');
    }
    const event = value as ChatEvent;
    this.acceptError(event.error);
    if (event.id !== undefined) {
      this.start(string(event.id, 'response ID'));
    }
    this.acceptUsage(event.usage);
    if (event.choices !== undefined) {
      this.acceptChoice(event.choices);
    }
  }

  private acceptError(error: unknown) {
    if (error === undefined) {
      return;
    }
    throw new Error(
      record(error) && typeof error.message === 'string' ? error.message : 'Zen Chat stream failed',
    );
  }

  private acceptUsage(value: unknown) {
    if (value === undefined || value === null) {
      return;
    }
    if (!validUsage(value)) {
      throw new Error('Malformed Zen Chat usage');
    }
    // Zen forwards cumulative usage snapshots; the last snapshot is authoritative.
    this.usageValue = value;
  }

  private acceptChoice(value: unknown) {
    if (!Array.isArray(value) || value.length > 1) {
      throw new Error('Zen Chat returned multiple choices');
    }
    if (value.length === 0) {
      return;
    }
    const choice = value[0];
    if (!record(choice)) {
      throw new Error('Malformed Zen Chat choice');
    }
    if (choice.index !== undefined && choice.index !== 0) {
      throw new Error('Zen Chat returned a non-primary choice');
    }
    if (this.ended) {
      throw new Error('Zen Chat emitted data after completion');
    }
    const item = delta(choice.delta);
    this.addReasoning(item.reasoning_content);
    this.addText(item.content);
    this.addTools(item.tool_calls);
    const stop = finishReason(choice.finish_reason);
    if (stop !== undefined) {
      if (this.stop !== undefined && this.stop !== 'stop_sequence' && this.stop !== stop) {
        throw new Error('Zen Chat changed finish reason');
      }
      if (this.stop === undefined) {
        this.stop = stop;
      }
      this.ended = true;
    }
  }

  private start(eventId: string) {
    if (this.started) {
      if (this.id !== eventId) {
        throw new Error('Zen Chat response ID changed');
      }
      return;
    }
    this.started = true;
    this.id = eventId;
    this.emit('message_start', {
      message: {
        id: eventId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.options.inputTokens ?? 0, output_tokens: 0 },
      },
    });
  }

  private beginText(): number {
    if (this.open?.kind === 'text') {
      return this.open.index;
    }
    this.closeOpen();
    this.textValue = '';
    this.textEmitted = 0;
    const index = this.content.length;
    this.open = { kind: 'text', index };
    this.content.push({ type: 'text', text: '' });
    this.emit('content_block_start', { index, content_block: { type: 'text', text: '' } });
    return index;
  }

  private beginReasoning(): number {
    if (this.open?.kind === 'thinking') {
      return this.open.index;
    }
    this.closeOpen();
    this.reasoning = '';
    const index = this.content.length;
    this.open = { kind: 'thinking', index };
    this.content.push({ type: 'thinking', thinking: '', signature: '' });
    this.emit('content_block_start', {
      index,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    });
    return index;
  }

  /** Finish the open block before another begins, as the Messages stream requires. */
  private closeOpen() {
    const open = this.open;
    if (!open) {
      return;
    }
    const block = this.content[open.index];
    if (block?.type === 'thinking') {
      block.signature = signature(this.model, this.reasoning);
      this.emit('content_block_delta', {
        index: open.index,
        delta: { type: 'signature_delta', signature: block.signature },
      });
    } else {
      this.flushText();
    }
    this.emit('content_block_stop', { index: open.index });
    this.open = undefined;
  }

  private addReasoning(value: unknown) {
    if (typeof value !== 'string') {
      return;
    }
    if (this.stoppedSequence || (!value && this.open?.kind !== 'thinking')) {
      return;
    }
    const index = this.beginReasoning();
    this.reasoning += value;
    const block = this.content[index];
    if (block?.type !== 'thinking') {
      throw new Error('Invalid reasoning state');
    }
    block.thinking = this.reasoning;
    if (value) {
      this.emit('content_block_delta', {
        index,
        delta: { type: 'thinking_delta', thinking: value },
      });
    }
  }

  private addText(value: unknown) {
    if (typeof value !== 'string') {
      return;
    }
    if (!value && this.open?.kind !== 'text') {
      return;
    }
    if (this.stoppedSequence) {
      return;
    }
    const index = this.beginText();
    this.textValue += value;
    const block = this.content[index];
    if (block?.type !== 'text') {
      throw new Error('Invalid text state');
    }
    const limit = this.textLimit();
    block.text = this.textValue.slice(0, limit);
    const emitted = this.textValue.slice(this.textEmitted, limit);
    this.textEmitted = limit;
    if (emitted) {
      this.emit('content_block_delta', { index, delta: { type: 'text_delta', text: emitted } });
    }
  }

  private textLimit(): number {
    let limit = prefixSafeLength(this.textValue, this.options.stopSequences ?? []);
    for (const sequence of this.options.stopSequences ?? []) {
      const at = this.textValue.indexOf(sequence);
      if (
        at >= 0 &&
        (this.stoppedSequence === null || at < this.textValue.indexOf(this.stoppedSequence))
      ) {
        this.stoppedSequence = sequence;
        limit = Math.min(limit, at);
      }
    }
    if (this.stoppedSequence) {
      this.stop = 'stop_sequence';
    }
    return limit;
  }

  private addTools(value: unknown) {
    if (value === undefined || value === null) {
      return;
    }
    if (!Array.isArray(value)) {
      throw new Error('Invalid tool_calls');
    }
    if (this.stoppedSequence) {
      return;
    }
    for (const item of value) {
      this.toolSlot(item);
    }
  }

  private toolSlot(raw: unknown): ToolSlot {
    if (!record(raw) || !Number.isSafeInteger(raw.index) || Number(raw.index) < 0) {
      throw new Error('Malformed Zen tool call delta');
    }
    const index = Number(raw.index);
    let slot = this.slots.get(index);
    if (!slot) {
      slot = { index, arguments: '', closed: false };
      this.slots.set(index, slot);
    }
    if (slot.closed) {
      throw new Error('Zen tool call continued after completion');
    }
    this.updateTool(slot, raw);
    return slot;
  }

  private updateTool(slot: ToolSlot, raw: Record<string, unknown>) {
    if (raw.id !== undefined && raw.id !== null) {
      const id = string(raw.id, 'tool call ID');
      if (slot.id !== undefined && slot.id !== id) {
        throw new Error('Zen tool call ID changed');
      }
      slot.id = id;
    }
    const fn = raw.function;
    if (fn === undefined) {
      return;
    }
    if (!record(fn)) {
      throw new Error('Malformed Zen function delta');
    }
    if (fn.name !== undefined && fn.name !== null) {
      const name = string(fn.name, 'tool name');
      if (slot.name !== undefined && slot.name !== name) {
        throw new Error('Zen tool name changed');
      }
      slot.name = name;
    }
    if (fn.arguments !== undefined && fn.arguments !== null) {
      slot.arguments += string(fn.arguments, 'tool arguments');
    }
  }

  finish(): MessagesResponse {
    if (!this.started || !this.id) {
      throw new Error('Zen Chat stream omitted response ID');
    }
    if (!this.stop) {
      throw new Error('Zen Chat stream ended before completion');
    }
    if (
      !this.usageValue ||
      this.usageValue.prompt_tokens === undefined ||
      this.usageValue.completion_tokens === undefined
    ) {
      throw new Error('Zen Chat omitted terminal usage');
    }
    this.flushText();
    if (this.stop === 'tool_use' && this.slots.size === 0) {
      throw new Error('Zen Chat promised tool calls but emitted none');
    }
    if (this.stop === 'end_turn' && this.slots.size > 0) {
      this.stop = 'tool_use';
    }
    this.finishStreamedBlocks();
    this.finishTools();
    if (!this.content.length) {
      throw new Error('Zen Chat completed with no content');
    }
    const resultUsage = usage(this.usageValue);
    const stopSequence = this.stoppedSequence;
    const stop = stopSequence ? 'stop_sequence' : this.stop;
    const safeguard_results = safeguardResults(this.options.safeguards, this.content, 'zen');
    this.emit('message_delta', {
      delta: {
        stop_reason: stop,
        stop_sequence: stopSequence,
        ...(safeguard_results === undefined ? {} : { safeguard_results }),
      },
      usage: resultUsage,
    });
    this.emit('message_stop', {});
    return {
      id: this.id,
      type: 'message',
      role: 'assistant',
      model: this.model,
      content: this.content,
      stop_reason: stop,
      stop_sequence: stopSequence,
      usage: resultUsage,
      ...(safeguard_results === undefined ? {} : { safeguard_results }),
      multi_usage: {
        source: 'provider',
        total_tokens: this.usageValue.prompt_tokens + this.usageValue.completion_tokens,
        model: this.model,
      },
    };
  }

  private finishTools() {
    for (const slot of [...this.slots.values()].sort((left, right) => left.index - right.index)) {
      if (!slot.id || !slot.name) {
        throw new Error('Zen Chat returned an incomplete tool call');
      }
      let input: unknown;
      try {
        input = JSON.parse(slot.arguments);
      } catch {
        throw new Error('Zen Chat returned invalid tool arguments');
      }
      if (!record(input)) {
        throw new Error('Zen Chat tool arguments must be an object');
      }
      const block: Extract<ResponseContentBlock, { type: 'tool_use' }> = {
        type: 'tool_use',
        id: callId(slot.id),
        name: this.options.toolNames?.get(slot.name) ?? slot.name,
        input,
      };
      if (this.options.toolNames && !this.options.toolNames.has(slot.name)) {
        throw new Error('Zen returned an undeclared tool');
      }
      if (this.content.some((item) => item.type === 'tool_use' && item.id === block.id)) {
        throw new Error('Zen repeated a tool call ID');
      }
      const index = this.content.length;
      this.content.push(block);
      slot.closed = true;
      this.emit('content_block_start', { index, content_block: { ...block, input: {} } });
      this.emit('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      });
      this.emit('content_block_stop', { index });
    }
  }

  private finishStreamedBlocks() {
    this.closeOpen();
  }

  private flushText() {
    if (this.open?.kind !== 'text' || this.stoppedSequence) {
      return;
    }
    const textIndex = this.open.index;
    const block = this.content[textIndex];
    if (block?.type !== 'text') {
      throw new Error('Invalid text state');
    }
    const remainder = this.textValue.slice(this.textEmitted);
    block.text = this.textValue;
    this.textEmitted = this.textValue.length;
    if (remainder) {
      this.emit('content_block_delta', {
        index: textIndex,
        delta: { type: 'text_delta', text: remainder },
      });
    }
  }
}

export async function fromChat(
  stream: AsyncIterable<Uint8Array>,
  model: string,
  emit: Emit = () => {},
  options: ChatResponseOptions = {},
): Promise<MessagesResponse> {
  const response = new ChatAccumulator(model, emit, options);
  for await (const event of readSse(stream)) {
    if (event !== null) {
      response.accept(event);
    }
  }
  return response.finish();
}

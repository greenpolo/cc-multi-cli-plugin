// ---------------------------------------------------------------------------
// Anthropic Messages, as Claude Code sends them. These arrive as untrusted JSON:
// fields the gateway inspects rather than forwards stay `unknown` so every use
// has to narrow them first.
// ---------------------------------------------------------------------------

interface ImageSource {
  type: string;
  media_type?: string;
  data?: unknown;
  url?: unknown;
}

/** A request content block. `type` selects which fields are meaningful; the
 *  translation validates them per block kind and rejects anything else. */
export interface ContentBlock {
  type: string;
  text?: unknown;
  source?: ImageSource;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  signature?: string;
  thinking?: string;
  data?: string;
  cache_control?: unknown;
  title?: string;
  tool_name?: string;
}

export interface RequestMessage {
  role: string;
  content: string | ContentBlock[];
}

interface Tool {
  type?: string;
  name?: string;
  description?: string;
  input_schema?: unknown;
  defer_loading?: boolean;
}

interface ToolChoice {
  type: string;
  name?: string;
  disable_parallel_tool_use?: boolean;
}

/** Structured-output request. The schema is forwarded verbatim, so it stays opaque. */
interface OutputFormat {
  type?: string;
  schema?: unknown;
}

export interface MessagesRequest {
  model?: string;
  max_tokens?: number;
  system?: string | ContentBlock[];
  messages?: RequestMessage[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  stop_sequences?: string[];
  output_config?: { effort?: string; format?: OutputFormat };
  output_format?: OutputFormat;
  stream?: boolean;
  thinking?: { type: string; budget_tokens?: number };
}

// ---------------------------------------------------------------------------
// Anthropic Messages, as the gateway answers them.
// ---------------------------------------------------------------------------

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type ResponseContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'thinking'; thinking: string; signature: string };

export interface MessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ResponseContentBlock[];
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  usage: Usage;
  /** Provider accounting metadata; estimates are never presented as billed usage. */
  multi_usage?: {
    source: 'provider' | 'estimate' | 'mixed' | 'unavailable';
    reasoning_tokens?: number;
    total_tokens?: number;
    /**
     * What a harness turn consumed across all its model calls. The standard
     * `usage` fields then carry the turn's last call, its live context.
     */
    consumed_input_tokens?: number;
    consumed_output_tokens?: number;
    consumed_cache_read_tokens?: number;
    consumed_cache_creation_tokens?: number;
    /** The model calls a harness turn made, when the harness identifies them. */
    model_calls?: number;
    replayed?: boolean;
    model?: string;
    effort?: string;
  };
  /**
   * The text a reply with display rows holds back for the message that follows
   * them; the gateway answers the engine's next request with it.
   */
  multi_followup?: string;
}

type BlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string };

export type StreamEventName =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'ping'
  | 'error';

/** An Anthropic SSE event without its `type`; the gateway merges the two. */
export type StreamEventBody =
  | { message: MessagesResponse }
  | { index: number; content_block: ResponseContentBlock }
  | { index: number; delta: BlockDelta }
  | { index: number }
  | { delta: { stop_reason: StopReason | null; stop_sequence: string | null }; usage: Usage }
  | { error: { type: string; message: string } }
  | Record<string, never>;

export type Emit = (type: StreamEventName, value: StreamEventBody) => void;

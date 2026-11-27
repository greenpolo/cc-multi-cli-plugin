import type { ChildProcess, spawn } from 'node:child_process';
import {
  NativeCliError,
  type NativeCliInput,
  nativeEnvironment,
  runNativeCli,
} from '../../multi-core/src/gateway/harness-process.ts';
import { isRecord } from '../../multi-core/src/gateway/record.ts';

/**
 * Codex app-server contract, read from `codex app-server generate-ts` on 0.172: JSON-RPC
 * lines over stdio. One process serves one native turn: `initialize`, then `thread/start`
 * or `thread/resume`, then `turn/start`, streaming notifications until `turn/completed`.
 * Closing stdin ends the process; Codex keeps the thread on disk under its own home.
 */

/** The client name and version Multi reports to the Codex app-server. */
const CODEX_CLIENT = { name: 'cc_multi', title: 'Claude Code Multi', version: '0.4.4' };

export type CodexSandbox = 'read-only' | 'danger-full-access';

/** One model call's tokens as Codex counts them: `input` includes the cached part. */
export interface CodexTokens {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export type CodexItem = Record<string, unknown> & { type: string; id: string };

export type CodexStreamEvent =
  | { event: 'thread'; threadId: string }
  | { event: 'text'; itemId: string; text: string }
  | { event: 'item'; phase: 'started' | 'completed'; item: CodexItem }
  | { event: 'usage'; last: CodexTokens; total: CodexTokens };

interface CodexTurnResult {
  threadId: string;
  turnId: string;
  status: string;
  error?: { message: string; info?: string };
}

export interface CodexRunOptions {
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  model: string;
  effort?: string;
  /** The Codex thread to continue; absent starts a new one. */
  resume?: string;
  sandbox: CodexSandbox;
  /** Per-thread `config.toml` overrides, as dotted keys. */
  config: Record<string, unknown>;
  /**
   * Turns off Codex MCP servers by name, or every configured one. The names are only known
   * after Codex reads its config, and an override for a server it lacks is refused.
   */
  mcpOff?:
    | { all: true }
    | { servers: readonly string[]; tools: Readonly<Record<string, string[]>> };
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  executable?: string;
  spawn?: (...args: Parameters<typeof spawn>) => ChildProcess;
  maxOutputBytes?: number;
  onEvent?: (event: CodexStreamEvent) => void;
}

export interface CodexRunResult {
  result: CodexTurnResult;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

class CodexCliError extends NativeCliError {
  constructor(
    message: string,
    code: string,
    details: ConstructorParameters<typeof NativeCliError>[2] = {},
  ) {
    super(message, code, details);
    this.name = 'CodexCliError';
  }
}

/**
 * Credentials of other providers never reach Codex, nor does the gateway's own token. Codex
 * owns its login and reads `CODEX_HOME` itself.
 */
function codexEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return nativeEnvironment({
    overrides,
    drop: [
      'ANTHROPIC_',
      'CURSOR_',
      'OPENCODE_',
      'GEMINI_API_KEY',
      'XAI_API_KEY',
      'MULTI_GATEWAY_TOKEN',
    ],
    extra: { NO_COLOR: '1' },
  });
}

const INITIALIZE = 0;
const CONFIG = 1;
const THREAD = 2;
const TURN = 3;

type TurnParser = {
  options: CodexRunOptions;
  io?: NativeCliInput;
  threadId?: string;
  terminal?: CodexTurnResult;
  failure?: NativeCliError;
  lastError?: { message: string; info?: string };
};

type Emit = (event: CodexStreamEvent) => void;
type Fail = (error: NativeCliError) => void;

function send(parser: TurnParser, message: unknown) {
  parser.io?.write(JSON.stringify(message));
}

function initializeRequest() {
  return {
    id: INITIALIZE,
    method: 'initialize',
    params: { clientInfo: CODEX_CLIENT, capabilities: null },
  };
}

/** Runs one Codex turn on a fresh app-server process. */
export async function runCodexTurn(options: CodexRunOptions): Promise<CodexRunResult> {
  const platform = options.platform ?? process.platform;
  const parser: TurnParser = { options };
  const run = await runNativeCli<TurnParser, CodexTurnResult, CodexStreamEvent>({
    name: 'Codex',
    executable: 'codex',
    configuredPath: options.executable,
    args: ['app-server'],
    cwd: options.cwd,
    platform,
    env: codexEnvironment(options.env),
    signal: options.signal,
    spawn: options.spawn,
    maxOutputBytes: options.maxOutputBytes,
    parser,
    converse: (io) => {
      parser.io = io;
      send(parser, initializeRequest());
    },
    parseLine: parseTurnLine,
    onEvent: options.onEvent,
    finish: finishTurn,
  });
  return { result: run.result, exitCode: run.exitCode, signal: run.signal, stderr: run.stderr };
}

function finishTurn(
  parser: TurnParser,
  aborted: boolean,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): CodexTurnResult | NativeCliError {
  if (parser.failure) {
    return new CodexCliError(parser.failure.message, parser.failure.code, {
      exitCode,
      signal,
      stderr,
      systemCode: parser.failure.systemCode,
    });
  }
  // Codex wrote the turn's outcome before stdin closed; how the process then ends is not news.
  if (parser.terminal) {
    return parser.terminal;
  }
  return new CodexCliError(
    aborted
      ? 'Codex was canceled before its turn completed'
      : 'Codex exited before its turn completed',
    aborted ? 'aborted' : 'no_terminal_result',
    { exitCode, signal, stderr },
  );
}

function parseMessage(line: string, fail: Fail): Record<string, unknown> | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(line);
    if (isRecord(value)) {
      return value;
    }
  } catch {
    // Reported below.
  }
  fail(new CodexCliError('Codex sent an unreadable app-server message', 'parse'));
  return undefined;
}

function parseTurnLine(line: string, parser: TurnParser, emit: Emit, fail: Fail) {
  const message = parseMessage(line, fail);
  if (!message || parser.terminal) {
    return;
  }
  if (typeof message.method === 'string' && 'id' in message) {
    refuseServerRequest(parser, message);
  } else if (typeof message.method === 'string') {
    notification(message.method, isRecord(message.params) ? message.params : {}, parser, emit);
  } else if ('id' in message) {
    response(message, parser, emit, fail);
  }
}

/**
 * Codex runs without approvals (`approvalPolicy: never`), so it asks nothing in normal use.
 * Anything it does ask (an MCP elicitation, a question for the user) has nobody to answer
 * it in a headless turn and is declined.
 */
function refuseServerRequest(parser: TurnParser, message: Record<string, unknown>) {
  send(parser, {
    id: message.id,
    error: { code: -32000, message: 'Claude Code runs this Codex turn unattended.' },
  });
}

function errorMessage(value: unknown): string {
  return isRecord(value) && typeof value.message === 'string' ? value.message : 'unknown error';
}

const STEPS: Record<number, string> = {
  [INITIALIZE]: 'initialize',
  [CONFIG]: 'config/read',
  [THREAD]: 'thread start',
  [TURN]: 'turn/start',
};

function response(message: Record<string, unknown>, parser: TurnParser, emit: Emit, fail: Fail) {
  const id = typeof message.id === 'number' ? message.id : -1;
  if ('error' in message) {
    fail(
      new CodexCliError(
        `Codex ${STEPS[id] ?? 'request'} failed: ${errorMessage(message.error)}`,
        'protocol',
      ),
    );
    return;
  }
  const result = isRecord(message.result) ? message.result : {};
  if (id === INITIALIZE) {
    send(parser, { method: 'initialized' });
    if (parser.options.mcpOff) {
      send(parser, { id: CONFIG, method: 'config/read', params: { cwd: parser.options.cwd } });
    } else {
      startThread(parser, {});
    }
  } else if (id === CONFIG) {
    const config = isRecord(result.config) ? result.config : {};
    startThread(parser, mcpOverrides(parser.options.mcpOff, config.mcp_servers));
  } else if (id === THREAD) {
    threadStarted(result, parser, emit, fail);
  }
}

/** Per-server overrides for the Codex MCP servers the policy turns off. */
function mcpOverrides(
  off: CodexRunOptions['mcpOff'],
  configured: unknown,
): Record<string, unknown> {
  const servers = isRecord(configured) ? Object.keys(configured) : [];
  const overrides: Record<string, unknown> = {};
  if (!off) {
    return overrides;
  }
  for (const server of servers) {
    if ('all' in off || off.servers.includes(server)) {
      overrides[`mcp_servers.${server}.enabled`] = false;
    } else if (off.tools[server]?.length) {
      overrides[`mcp_servers.${server}.disabled_tools`] = off.tools[server];
    }
  }
  return overrides;
}

function startThread(parser: TurnParser, mcp: Record<string, unknown>) {
  const { options } = parser;
  const params = {
    model: options.model,
    cwd: options.cwd,
    approvalPolicy: 'never',
    sandbox: options.sandbox,
    config: { ...options.config, ...mcp },
  };
  send(
    parser,
    options.resume
      ? {
          id: THREAD,
          method: 'thread/resume',
          params: { ...params, threadId: options.resume, excludeTurns: true },
        }
      : { id: THREAD, method: 'thread/start', params },
  );
}

function threadStarted(
  result: Record<string, unknown>,
  parser: TurnParser,
  emit: Emit,
  fail: Fail,
) {
  const thread = isRecord(result.thread) ? result.thread : {};
  if (typeof thread.id !== 'string' || !thread.id) {
    fail(new CodexCliError('Codex started a thread without an id', 'parse'));
    return;
  }
  const { options } = parser;
  // Codex owns the identity it reports; a different one would silently fork the history.
  if (options.resume && thread.id !== options.resume) {
    fail(
      new CodexCliError(`Codex resumed thread ${thread.id} instead of ${options.resume}`, 'parse'),
    );
    return;
  }
  parser.threadId = thread.id;
  emit({ event: 'thread', threadId: thread.id });
  send(parser, {
    id: TURN,
    method: 'turn/start',
    params: {
      threadId: thread.id,
      input: [{ type: 'text', text: options.prompt, text_elements: [] }],
      model: options.model,
      ...(options.effort ? { effort: options.effort } : {}),
    },
  });
}

type Handler = (params: Record<string, unknown>, parser: TurnParser, emit: Emit) => void;

function item(phase: 'started' | 'completed'): Handler {
  return (params, _parser, emit) => {
    const value = params.item;
    if (isRecord(value) && typeof value.type === 'string' && typeof value.id === 'string') {
      emit({ event: 'item', phase, item: value as CodexItem });
    }
  };
}

/** The notifications a turn reads; every other one is ignored, so a newer Codex stays readable. */
const HANDLERS: Readonly<Record<string, Handler>> = {
  'item/agentMessage/delta': (params, _parser, emit) => {
    if (typeof params.delta === 'string' && typeof params.itemId === 'string') {
      emit({ event: 'text', itemId: params.itemId, text: params.delta });
    }
  },
  'item/started': item('started'),
  'item/completed': item('completed'),
  'thread/tokenUsage/updated': (params, _parser, emit) => usage(params, emit),
  error: (params, parser) => {
    if (params.willRetry !== true && isRecord(params.error)) {
      parser.lastError = turnError(params.error);
    }
  },
  'turn/completed': (params, parser) => completed(params, parser),
};

function notification(
  method: string,
  params: Record<string, unknown>,
  parser: TurnParser,
  emit: Emit,
) {
  // Codex subagents run their own threads on the same connection; only this one answers.
  if (parser.threadId === undefined || params.threadId !== parser.threadId) {
    return;
  }
  if (Object.hasOwn(HANDLERS, method)) {
    HANDLERS[method]?.(params, parser, emit);
  }
}

function tokens(value: unknown): CodexTokens | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const count = (key: string) => {
    const entry = value[key];
    return typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0 ? entry : 0;
  };
  return {
    totalTokens: count('totalTokens'),
    inputTokens: count('inputTokens'),
    cachedInputTokens: count('cachedInputTokens'),
    outputTokens: count('outputTokens'),
    reasoningOutputTokens: count('reasoningOutputTokens'),
  };
}

function usage(params: Record<string, unknown>, emit: Emit) {
  const info = isRecord(params.tokenUsage) ? params.tokenUsage : {};
  const last = tokens(info.last);
  const total = tokens(info.total);
  if (last && total) {
    emit({ event: 'usage', last, total });
  }
}

function turnError(value: Record<string, unknown>): { message: string; info?: string } {
  const info = value.codexErrorInfo;
  let name: string | undefined;
  if (typeof info === 'string') {
    name = info;
  } else if (isRecord(info)) {
    name = Object.keys(info)[0];
  }
  return { message: errorMessage(value), ...(name ? { info: name } : {}) };
}

function completed(params: Record<string, unknown>, parser: TurnParser) {
  const turn = isRecord(params.turn) ? params.turn : {};
  if (typeof turn.id !== 'string' || typeof turn.status !== 'string' || !parser.threadId) {
    return;
  }
  const error = isRecord(turn.error) ? turnError(turn.error) : parser.lastError;
  parser.terminal = {
    threadId: parser.threadId,
    turnId: turn.id,
    status: turn.status,
    ...(error ? { error } : {}),
  };
  parser.io?.end();
}

type QueryParser = {
  methods: readonly { method: string; params?: unknown }[];
  results: unknown[];
  io?: NativeCliInput;
  terminal?: unknown[];
  failure?: NativeCliError;
};

/**
 * Asks a short-lived app-server a few read-only questions in order (the account, the model
 * list, the quota windows) and returns their results. Nothing here starts a model.
 */
export async function queryCodex(
  methods: readonly { method: string; params?: unknown }[],
  options: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    executable?: string;
    timeoutMs?: number;
  } = {},
): Promise<unknown[]> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const parser: QueryParser = { methods, results: [] };
  const run = await runNativeCli<QueryParser, unknown[]>({
    name: 'Codex',
    executable: 'codex',
    configuredPath: options.executable,
    args: ['app-server'],
    cwd: process.cwd(),
    platform: options.platform ?? process.platform,
    env: codexEnvironment(options.env),
    signal,
    maxOutputBytes: 4 * 1024 * 1024,
    parser,
    converse: (io) => {
      parser.io = io;
      io.write(JSON.stringify(initializeRequest()));
    },
    parseLine: parseQueryLine,
    finish: (state, aborted) =>
      state.failure ??
      state.terminal ??
      new CodexCliError(
        aborted ? 'Codex did not answer in time' : 'Codex exited before answering',
        aborted ? 'aborted' : 'no_terminal_result',
      ),
  });
  return run.result;
}

function parseQueryLine(line: string, parser: QueryParser, _emit: unknown, fail: Fail) {
  const message = parseMessage(line, fail);
  if (!message || parser.terminal || typeof message.method === 'string' || !('id' in message)) {
    return;
  }
  if ('error' in message) {
    fail(new CodexCliError(`Codex request failed: ${errorMessage(message.error)}`, 'protocol'));
    return;
  }
  if (message.id === INITIALIZE) {
    parser.io?.write(JSON.stringify({ method: 'initialized' }));
  } else if (message.id === parser.results.length + 1) {
    parser.results.push(message.result);
  } else {
    return;
  }
  const next = parser.methods[parser.results.length];
  if (next) {
    parser.io?.write(JSON.stringify({ id: parser.results.length + 1, ...next }));
  } else {
    parser.terminal = parser.results;
    parser.io?.end();
  }
}

import type { ChildProcess, spawn } from 'node:child_process';
import {
  NativeCliError,
  nativeEnvironment,
  promptArgumentLimitBytes,
  runNativeCli,
} from '../../multi-core/src/gateway/harness-process.ts';
import { isRecord } from '../../multi-core/src/gateway/harness-session.ts';

type AntigravityStatus =
  | 'SUCCESS'
  | 'ERROR'
  | 'CANCELED'
  | 'INTERRUPTED'
  | 'INVALID'
  | 'WAITING'
  | 'RUNNING';

export interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

interface AntigravityInit {
  cwd?: string;
  tools?: string[];
  permission_mode?: string;
  model?: string;
  agent?: string;
  [key: string]: unknown;
}

interface AntigravityStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  tool_name?: string;
  text_delta?: string;
  duration_seconds?: number;
  usage?: AntigravityUsage;
  tool_info?: Record<string, unknown>;
  subagent_info?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AntigravityResult {
  conversation_id: string;
  status: AntigravityStatus;
  response: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AntigravityUsage;
  [key: string]: unknown;
}

export type AntigravityStreamEvent =
  | { event: 'init'; conversation_id: string; init: AntigravityInit }
  | { event: 'step_update'; step_update: AntigravityStepUpdate }
  | { event: 'result'; result: AntigravityResult };

export interface AntigravityRunOptions {
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  conversation?: string;
  agent?: string;
  mode?: 'plan';
  newProject?: boolean;
  printTimeout?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  executable?: string;
  spawn?: (...args: Parameters<typeof spawn>) => ChildProcess;
  maxOutputBytes?: number;
  onEvent?: (event: AntigravityStreamEvent) => void;
}

export interface AntigravityRunResult {
  result: AntigravityResult;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** agy's own failure codes; the shared runner reports the first three. */
export type AntigravityCliCode =
  | 'spawn'
  | 'output_limit'
  | 'parse'
  | 'no_terminal_result'
  | 'aborted';

const CLI_CODES: readonly string[] = [
  'spawn',
  'output_limit',
  'parse',
  'no_terminal_result',
  'aborted',
];

/** agy's own failures, so a caller can tell them from another provider's. */
export class AntigravityCliError extends NativeCliError {
  constructor(
    message: string,
    code: AntigravityCliCode,
    details: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      systemCode?: string;
    } = {},
  ) {
    super(message, code, details);
    this.name = 'AntigravityCliError';
  }
}

/** A shared-runner failure keeps its own code; anything unknown reads as a parse fault. */
function cliCode(code: string): AntigravityCliCode {
  return CLI_CODES.includes(code) ? (code as AntigravityCliCode) : 'parse';
}

/**
 * `runNativeCli` raises its own generic spawn failures as a bare `NativeCliError`
 * before any agy parser state exists — a synchronous spawn throw never reaches
 * `finishValue`. Those are rewrapped so every failure this module reports is an
 * `AntigravityCliError`.
 */
function toAntigravityCliError(error: unknown): AntigravityCliError {
  if (error instanceof AntigravityCliError) {
    return error;
  }
  if (error instanceof NativeCliError) {
    return new AntigravityCliError(error.message, cliCode(error.code), {
      exitCode: error.exitCode,
      signal: error.signal,
      stderr: error.stderr,
      systemCode: error.systemCode,
    });
  }
  throw error;
}

function antigravityArguments(options: AntigravityRunOptions, promptOnStdin: boolean): string[] {
  const args = promptOnStdin
    ? ['--input-format', 'stream-json', '--output-format', 'stream-json']
    : ['-p', options.prompt, '--output-format', 'stream-json'];
  args.push('--disable-slash-commands');
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (options.conversation) {
    args.push('--conversation', options.conversation);
  }
  if (options.agent) {
    args.push('--agent', options.agent);
  }
  args.push('--add-dir', options.cwd);
  if (options.newProject ?? !options.conversation) {
    args.push('--new-project');
  }
  if (options.mode) {
    args.push('--mode', options.mode);
  }
  if (options.printTimeout) {
    args.push('--print-timeout', options.printTimeout);
  }
  // Native Ask/Deny config is bypassed on purpose: headless Ask is a denial and
  // nobody using this gateway maintains native config. Claude's rules and the
  // gateway's own pre-tool hook are the only enforcement that matters.
  args.push('--dangerously-skip-permissions');
  return args;
}

export async function runAntigravity(
  options: AntigravityRunOptions,
): Promise<AntigravityRunResult> {
  try {
    return await spawnAntigravity(options);
  } catch (error) {
    throw toAntigravityCliError(error);
  }
}

function spawnAntigravity(options: AntigravityRunOptions): Promise<AntigravityRunResult> {
  const platform = options.platform ?? process.platform;
  const promptOnStdin = Buffer.byteLength(options.prompt) >= promptArgumentLimitBytes(platform);
  const environment = antigravityEnvironment(options.env);
  return runNativeCli<ParserState, AntigravityResult>({
    name: 'Antigravity',
    executable: 'agy',
    configuredPath: options.executable,
    args: antigravityArguments(options, promptOnStdin),
    cwd: options.cwd,
    platform,
    env: environment,
    signal: options.signal,
    spawn: options.spawn,
    maxOutputBytes: options.maxOutputBytes,
    // The oversized prompt travels as one stream-json user event on stdin.
    stdin: promptOnStdin
      ? `${JSON.stringify({ event: 'user', message: { content: options.prompt } })}\n`
      : undefined,
    parser: { initSeen: false },
    parseLine,
    onEvent: (event) => options.onEvent?.(event as AntigravityStreamEvent),
    finish: finishValue,
  });
}

type ParserState = {
  conversationId?: string;
  initSeen: boolean;
  terminal?: AntigravityResult;
  failure?: NativeCliError;
};

function finishValue(
  parser: ParserState,
  aborted: boolean,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): AntigravityResult | NativeCliError {
  if (parser.failure) {
    return new AntigravityCliError(parser.failure.message, cliCode(parser.failure.code), {
      exitCode,
      signal,
      stderr,
    });
  }
  if (parser.terminal) {
    if (parser.terminal.status === 'SUCCESS' && (exitCode !== 0 || signal !== null)) {
      return new AntigravityCliError(
        'Antigravity reported success with a failed process exit',
        'parse',
        { exitCode, signal, stderr },
      );
    }
    return parser.terminal;
  }
  return new AntigravityCliError(
    aborted
      ? 'Antigravity was canceled before a terminal result was received'
      : 'Antigravity exited without a terminal result',
    aborted ? 'aborted' : 'no_terminal_result',
    { exitCode, signal, stderr },
  );
}

function parseLine(
  line: string,
  parser: ParserState,
  emit: (event: unknown) => void,
  fail: (error: NativeCliError) => void,
) {
  if (!line.trim()) {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    fail(new AntigravityCliError(`Invalid agy NDJSON event: ${String(error)}`, 'parse'));
    return;
  }
  if (!isRecord(value) || typeof value.event !== 'string') {
    fail(new AntigravityCliError('Invalid agy NDJSON event envelope', 'parse'));
    return;
  }
  if (value.event === 'init') {
    parseInit(value, parser, emit, fail);
  } else if (value.event === 'step_update') {
    parseStep(value, parser, emit, fail);
  } else if (value.event === 'result') {
    parseTerminal(value, parser, emit, fail);
  }
}

function parseInit(
  value: Record<string, unknown>,
  parser: ParserState,
  emit: (event: AntigravityStreamEvent) => void,
  fail: (error: NativeCliError) => void,
) {
  const init = record(value.init);
  if (!init || typeof value.conversation_id !== 'string' || parser.initSeen || parser.terminal) {
    fail(new AntigravityCliError('Invalid agy init event', 'parse'));
    return;
  }
  parser.conversationId = value.conversation_id;
  parser.initSeen = true;
  emit({ event: 'init', conversation_id: value.conversation_id, init });
}

function parseStep(
  value: Record<string, unknown>,
  parser: ParserState,
  emit: (event: AntigravityStreamEvent) => void,
  fail: (error: NativeCliError) => void,
) {
  const stepUpdate = record(value.step_update);
  if (!stepUpdate || !parser.initSeen || !matchesConversation(stepUpdate, parser.conversationId)) {
    fail(new AntigravityCliError('Invalid agy step_update event', 'parse'));
    return;
  }
  emit({ event: 'step_update', step_update: stepUpdate });
}

function parseTerminal(
  value: Record<string, unknown>,
  parser: ParserState,
  emit: (event: AntigravityStreamEvent) => void,
  fail: (error: NativeCliError) => void,
) {
  const result = parseResult(value.result);
  if (
    !result ||
    parser.terminal ||
    (parser.initSeen && result.conversation_id !== parser.conversationId)
  ) {
    fail(new AntigravityCliError('Invalid agy result event', 'parse'));
    return;
  }
  if (!parser.initSeen && result.status !== 'ERROR') {
    fail(new AntigravityCliError('Invalid agy result event', 'parse'));
    return;
  }
  parser.conversationId = result.conversation_id;
  parser.terminal = result;
  emit({ event: 'result', result });
}

export function antigravityEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return nativeEnvironment({
    overrides,
    drop: [
      'ANTHROPIC_',
      'OPENAI_',
      'CURSOR_',
      'OPENCODE_',
      'GEMINI_API_KEY',
      'GOOGLE_GEMINI_BASE_URL',
      'MULTI_GATEWAY_TOKEN',
    ],
  });
}

function matchesConversation(value: Record<string, unknown>, conversationId: string | undefined) {
  return typeof value.conversation_id !== 'string' || value.conversation_id === conversationId;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function parseUsage(value: unknown): AntigravityUsage | undefined {
  const usage = record(value);
  if (!usage) {
    return undefined;
  }
  const parsed: AntigravityUsage = {};
  for (const key of [
    'input_tokens',
    'output_tokens',
    'thinking_tokens',
    'cache_read_tokens',
    'total_tokens',
  ] as const) {
    if (typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && usage[key] >= 0) {
      parsed[key] = usage[key];
    }
  }
  return parsed;
}

function parseResult(value: unknown): AntigravityResult | undefined {
  const result = record(value);
  if (
    !result ||
    typeof result.conversation_id !== 'string' ||
    typeof result.status !== 'string' ||
    !isStatus(result.status) ||
    typeof result.response !== 'string'
  ) {
    return undefined;
  }
  return {
    ...result,
    conversation_id: result.conversation_id,
    status: result.status,
    response: result.response,
    usage: parseUsage(result.usage),
  };
}

function isStatus(value: string): value is AntigravityStatus {
  return ['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING'].includes(
    value as AntigravityStatus,
  );
}

import type { ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  NativeCliError,
  nativeEnvironment,
  promptArgumentLimitBytes,
  runNativeCli,
} from '../../multi-core/src/gateway/harness-process.ts';

/**
 * Grok Build headless contract, captured from `grok -p --output-format streaming-json`
 * on 1.0.35. The binary's own `--help` advertises ACP session updates; it emits this
 * simpler NDJSON instead, so the recorded stream is the contract, not the help text.
 */

export interface GrokUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

export interface GrokToolCall {
  toolCallId: string;
  toolName?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
}

export interface GrokResult {
  sessionId: string;
  stopReason: string;
  requestId?: string;
  usage?: GrokUsage;
  turns?: number;
  /** Billed for this invocation only; `grok usage <id>` sums a whole session. */
  costUsd?: number;
  modelUsage?: Record<string, unknown>;
}

export type GrokStreamEvent =
  | { event: 'tools'; tools: readonly string[] }
  | { event: 'thought'; text: string }
  | { event: 'text'; text: string }
  | { event: 'tool_call'; call: GrokToolCall }
  | { event: 'tool_update'; call: GrokToolCall }
  | { event: 'usage'; usage: GrokUsage }
  | { event: 'result'; result: GrokResult };

export type GrokPermissionMode = 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface GrokRunOptions {
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  model?: string;
  effort?: string;
  /** New session identity, chosen by the gateway so a run ID exists before any output. */
  session?: string;
  /** Existing session to continue; mutually exclusive with `session`. */
  resume?: string;
  mode?: GrokPermissionMode;
  tools?: readonly string[];
  disallowedTools?: readonly string[];
  allow?: readonly string[];
  deny?: readonly string[];
  /**
   * Tool names the policy claims to have removed. `--disallowed-tools` accepts an
   * unknown name and runs the tool anyway, so the announced toolset is the only
   * evidence that a removal took effect. The set legitimately grows mid-run as MCP
   * servers connect, so this is a forbidden list, never an exhaustive one.
   */
  forbiddenTools?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  executable?: string;
  spawn?: (...args: Parameters<typeof spawn>) => ChildProcess;
  maxOutputBytes?: number;
  onEvent?: (event: GrokStreamEvent) => void;
}

export interface GrokRunResult {
  result: GrokResult;
  /** Assistant text, accumulated from deltas: the terminal event carries none. */
  response: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/**
 * Grok's own failure vocabulary, layered on the shared native-CLI error so a policy
 * breach or an unparsable event stays as specific as `runNativeCli`'s generic
 * `spawn`/`output_limit` failures are not.
 */
export class GrokCliError extends NativeCliError {
  declare readonly code:
    | 'spawn'
    | 'output_limit'
    | 'parse'
    | 'policy'
    | 'no_terminal_result'
    | 'aborted';

  constructor(
    message: string,
    code: GrokCliError['code'],
    details: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      systemCode?: string;
    } = {},
  ) {
    super(message, code, details);
    this.name = 'GrokCliError';
  }
}

/**
 * `runNativeCli` raises its own generic spawn/output-limit failures as a bare
 * `NativeCliError` before any Grok-specific parser state exists. Those are rewrapped
 * here so every failure this module reports is a `GrokCliError`.
 */
function toGrokCliError(error: unknown): GrokCliError {
  if (error instanceof GrokCliError) {
    return error;
  }
  if (error instanceof NativeCliError) {
    return new GrokCliError(error.message, error.code as GrokCliError['code'], {
      exitCode: error.exitCode,
      signal: error.signal,
      stderr: error.stderr,
      systemCode: error.systemCode,
    });
  }
  throw error;
}

/** Credentials of other providers never reach the native CLI. */
export function grokEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return nativeEnvironment({
    overrides,
    // An API key silently outranks the browser login and moves billing from the
    // subscription to metered xAI credit. This bridge runs on the account login.
    drop: [
      'ANTHROPIC_',
      'OPENAI_',
      'CURSOR_',
      'OPENCODE_',
      'GEMINI_API_KEY',
      'MULTI_GATEWAY_TOKEN',
      'XAI_API_KEY',
    ],
    extra: { NO_COLOR: '1' },
  });
}

function grokArguments(options: GrokRunOptions, promptFile: string | undefined): string[] {
  const args = promptFile ? ['--prompt-file', promptFile] : ['-p', options.prompt];
  args.push('--output-format', 'streaming-json', '--no-auto-update');
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push('--reasoning-effort', options.effort);
  }
  if (options.mode) {
    args.push('--permission-mode', options.mode);
  }
  if (options.resume) {
    args.push('--resume', options.resume);
  } else if (options.session) {
    args.push('--session-id', options.session);
  }
  if (options.tools?.length) {
    args.push('--tools', options.tools.join(','));
  }
  if (options.disallowedTools?.length) {
    args.push('--disallowed-tools', options.disallowedTools.join(','));
  }
  for (const rule of options.allow ?? []) {
    args.push('--allow', rule);
  }
  for (const rule of options.deny ?? []) {
    args.push('--deny', rule);
  }
  args.push('--cwd', options.cwd);
  return args;
}

export async function runGrok(options: GrokRunOptions): Promise<GrokRunResult> {
  if (options.resume && options.session) {
    throw new GrokCliError('Grok resumes a session or creates one, never both', 'spawn');
  }
  const platform = options.platform ?? process.platform;
  const oversized = Buffer.byteLength(options.prompt) >= promptArgumentLimitBytes(platform);
  const directory = oversized ? await mkdtemp(path.join(os.tmpdir(), 'multi-grok-')) : undefined;
  const promptFile = directory ? path.join(directory, 'prompt.txt') : undefined;
  if (promptFile) {
    await writeFile(promptFile, options.prompt, { encoding: 'utf8', mode: 0o600 });
  }
  try {
    return await spawnGrok(options, platform, promptFile);
  } catch (error) {
    throw toGrokCliError(error);
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

type ParserState = {
  response: string;
  forbidden?: readonly string[];
  tools?: readonly string[];
  terminal?: GrokResult;
  failure?: NativeCliError;
};

type Emit = (event: GrokStreamEvent) => void;
type Fail = (error: GrokCliError) => void;

async function spawnGrok(
  options: GrokRunOptions,
  platform: NodeJS.Platform,
  promptFile: string | undefined,
): Promise<GrokRunResult> {
  const parser: ParserState = { response: '', forbidden: options.forbiddenTools };
  const run = await runNativeCli<ParserState, GrokResult, GrokStreamEvent>({
    name: 'Grok',
    executable: 'grok',
    configuredPath: options.executable,
    args: grokArguments(options, promptFile),
    cwd: options.cwd,
    platform,
    env: grokEnvironment(options.env),
    signal: options.signal,
    spawn: options.spawn,
    maxOutputBytes: options.maxOutputBytes,
    parser,
    parseLine: parseGrokLine,
    onEvent: options.onEvent,
    finish: finishValue,
  });
  return {
    result: run.result,
    response: parser.response,
    exitCode: run.exitCode,
    signal: run.signal,
    stderr: run.stderr,
  };
}

function finishValue(
  parser: ParserState,
  aborted: boolean,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): GrokResult | GrokCliError {
  if (parser.failure) {
    return new GrokCliError(parser.failure.message, parser.failure.code as GrokCliError['code'], {
      exitCode,
      signal,
      stderr,
      systemCode: parser.failure.systemCode,
    });
  }
  if (parser.terminal) {
    if (exitCode !== 0 || signal !== null) {
      return new GrokCliError(
        'Grok reported a terminal result with a failed process exit',
        'parse',
        {
          exitCode,
          signal,
          stderr,
        },
      );
    }
    return parser.terminal;
  }
  return new GrokCliError(
    aborted
      ? 'Grok was canceled before a terminal result was received'
      : 'Grok exited without a terminal result',
    aborted ? 'aborted' : 'no_terminal_result',
    { exitCode, signal, stderr },
  );
}

/** Unknown event types are ignored so a newer CLI stays readable. */
function parseGrokLine(line: string, parser: ParserState, emit: Emit, fail: Fail) {
  if (!line.trim()) {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    fail(new GrokCliError(`Invalid grok NDJSON event: ${String(error)}`, 'parse'));
    return;
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    fail(new GrokCliError('Invalid grok NDJSON event envelope', 'parse'));
    return;
  }
  if (parser.terminal) {
    fail(new GrokCliError('Grok continued streaming after its terminal event', 'parse'));
    return;
  }
  parseEvent(value.type, value, parser, emit, fail);
}

function parseEvent(
  type: string,
  value: Record<string, unknown>,
  parser: ParserState,
  emit: Emit,
  fail: Fail,
) {
  if (type === 'available_commands') {
    parseTools(value, parser, emit, fail);
  } else if (type === 'thought' || type === 'text') {
    parseDelta(type, value, parser, emit, fail);
  } else if (type === 'tool_call' || type === 'tool_call_update') {
    parseToolCall(type, value, emit, fail);
  } else if (type === 'usage') {
    parseUsageEvent(value, emit, fail);
  } else if (type === 'end') {
    parseTerminal(value, parser, emit, fail);
  }
}

/**
 * The announced toolset is the only evidence that a removal took effect: the CLI
 * accepts unknown `--disallowed-tools` names and runs the tool anyway. Every
 * announcement is checked, because the set grows once MCP servers connect.
 */
function parseTools(value: Record<string, unknown>, parser: ParserState, emit: Emit, fail: Fail) {
  const tools = stringArray(value.tools);
  if (!tools) {
    fail(new GrokCliError('Invalid grok available_commands event', 'parse'));
    return;
  }
  const forbidden = new Set(parser.forbidden ?? []);
  const breach = tools.filter((tool) => forbidden.has(tool));
  if (breach.length) {
    fail(
      new GrokCliError(
        `Grok did not apply the session tool policy: ${breach.join(', ')} remains available`,
        'policy',
      ),
    );
    return;
  }
  if (parser.tools && sameTools(parser.tools, tools)) {
    return;
  }
  parser.tools = tools;
  emit({ event: 'tools', tools });
}

function parseDelta(
  type: 'thought' | 'text',
  value: Record<string, unknown>,
  parser: ParserState,
  emit: Emit,
  fail: Fail,
) {
  if (typeof value.data !== 'string') {
    fail(new GrokCliError(`Invalid grok ${type} event`, 'parse'));
    return;
  }
  if (type === 'text') {
    parser.response += value.data;
  }
  emit({ event: type, text: value.data });
}

function parseToolCall(
  type: 'tool_call' | 'tool_call_update',
  value: Record<string, unknown>,
  emit: Emit,
  fail: Fail,
) {
  if (typeof value.toolCallId !== 'string' || !value.toolCallId) {
    fail(new GrokCliError(`Invalid grok ${type} event`, 'parse'));
    return;
  }
  const call: GrokToolCall = {
    toolCallId: value.toolCallId,
    toolName: optionalString(value.toolName),
    title: optionalString(value.title),
    kind: optionalString(value.kind),
    status: optionalString(value.status),
    rawInput: value.rawInput,
    rawOutput: value.rawOutput,
    content: value.content,
  };
  emit({ event: type === 'tool_call' ? 'tool_call' : 'tool_update', call });
}

function parseUsageEvent(value: Record<string, unknown>, emit: Emit, fail: Fail) {
  const usage = parseUsage(value.usage);
  if (!usage) {
    fail(new GrokCliError('Invalid grok usage event', 'parse'));
    return;
  }
  // `signature` carries provider-owned reasoning state; it stays at this boundary.
  emit({ event: 'usage', usage });
}

function parseTerminal(
  value: Record<string, unknown>,
  parser: ParserState,
  emit: Emit,
  fail: Fail,
) {
  if (typeof value.sessionId !== 'string' || typeof value.stopReason !== 'string') {
    fail(new GrokCliError('Invalid grok end event', 'parse'));
    return;
  }
  const result: GrokResult = {
    sessionId: value.sessionId,
    stopReason: value.stopReason,
    requestId: optionalString(value.requestId),
    usage: parseUsage(value.usage),
    turns: optionalCount(value.num_turns),
    costUsd: optionalCost(value.total_cost_usd),
    modelUsage: isRecord(value.modelUsage) ? value.modelUsage : undefined,
  };
  parser.terminal = result;
  emit({ event: 'result', result });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return undefined;
  }
  return value as string[];
}

function sameTools(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

function parseUsage(value: unknown): GrokUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage: GrokUsage = {};
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'reasoning_tokens',
    'total_tokens',
  ] as const) {
    const count = optionalCount(value[key]);
    if (count !== undefined) {
      usage[key] = count;
    }
  }
  return usage;
}

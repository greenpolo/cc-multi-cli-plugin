import { type ChildProcess, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { executableInvocation, resolveExecutable } from './executable.ts';
import { terminateProcessTree } from './process-tree.ts';

export const defaultMaxOutputBytes = 8 * 1024 * 1024;
export const interruptGraceMs = 1500;
export const terminateGraceMs = 1500;
export const cancellationWaitMs = interruptGraceMs + terminateGraceMs + 1000;

// cmd.exe caps a command line at 8,191 characters when a .cmd shim cannot be
// bypassed; the fixed flags, executable path, cwd and quoting need the rest.
const windowsPromptArgumentLimitBytes = 6 * 1024;
const posixPromptArgumentLimitBytes = 128 * 1024;

export function promptArgumentLimitBytes(platform: NodeJS.Platform): number {
  return platform === 'win32' ? windowsPromptArgumentLimitBytes : posixPromptArgumentLimitBytes;
}

/**
 * Credentials of other providers never reach a native CLI. A `drop` entry ending
 * in `_` removes a whole prefix; any other entry removes exactly that name.
 */
export function nativeEnvironment(options: {
  overrides?: NodeJS.ProcessEnv;
  keep?: readonly string[];
  drop?: readonly string[];
  extra?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.overrides,
    ...options.extra,
  };
  const keep = new Set(options.keep ?? []);
  const drop = options.drop ?? [];
  for (const key of Object.keys(environment)) {
    if (!keep.has(key) && drop.some((entry) => matchesEnvironmentName(key, entry))) {
      delete environment[key];
    }
  }
  return environment;
}

function matchesEnvironmentName(key: string, entry: string): boolean {
  return entry.endsWith('_') ? key.startsWith(entry) : key === entry;
}

export function redactStderr(value: string): string {
  return value
    .replaceAll(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replaceAll(/([?&](?:api[_-]?key|token|password)=)[^&\s]+/gi, '$1[redacted]');
}

export class NativeCliError extends Error {
  readonly code: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  /**
   * The operating system's own reason a process could not be created, when it
   * gave one: `ENOENT` for a missing binary, `EAGAIN` for a machine momentarily
   * out of processes. Only that code tells a permanent failure from a transient
   * one.
   */
  readonly systemCode: string | undefined;

  constructor(
    message: string,
    code: string,
    details: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      systemCode?: string;
    } = {},
  ) {
    super(message);
    this.name = 'NativeCliError';
    this.code = code;
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stderr = details.stderr ?? '';
    this.systemCode = details.systemCode;
  }
}

/** Node reports the OS failure as `code` on the error it throws or emits. */
function spawnSystemCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

type NativeParser = { terminal?: unknown; failure?: NativeCliError };

type NativeCliSpec<P extends NativeParser, R> = {
  /** Message subject, for example `Grok`. */
  name: string;
  /** Binary to resolve on PATH, for example `grok`. */
  executable: string;
  /** An explicit binary path, when the provider was configured with one. */
  configuredPath?: string;
  args: readonly string[];
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  spawn?: (...args: Parameters<typeof spawn>) => ChildProcess;
  maxOutputBytes?: number;
  /** Prompt delivered on stdin instead of as an argument. */
  stdin?: string;
  parser: P;
  parseLine: (
    line: string,
    parser: P,
    emit: (event: unknown) => void,
    fail: (error: NativeCliError) => void,
  ) => void;
  onEvent?: (event: unknown) => void;
  /**
   * The provider decides what its stream proved. It stays provider-side because
   * a missing terminal result must never become a success, and providers
   * disagree about a failed exit that follows a terminal result.
   */
  finish: (
    parser: P,
    aborted: boolean,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ) => R | NativeCliError;
};

type NativeCliRun<R> = {
  result: R;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

type RunContext<P extends NativeParser, R> = {
  spec: NativeCliSpec<P, R>;
  child: ChildProcess;
  decoder: StringDecoder;
  limit: number;
  buffer: string;
  stdoutBytes: number;
  stderrBytes: number;
  stderr: string;
  aborted: boolean;
  settled: boolean;
  interruptTimer?: NodeJS.Timeout;
  terminateTimer?: NodeJS.Timeout;
  cancellationTimer?: NodeJS.Timeout;
  onAbort: () => void;
  resolve: (value: NativeCliRun<R>) => void;
  reject: (error: unknown) => void;
};

/**
 * Run a native CLI and let its own grammar decide what happened. Cancellation is
 * escalated SIGINT, SIGTERM, SIGKILL across the whole process tree, and a run
 * that stops without a terminal result is never reported as an answer.
 */
export function runNativeCli<P extends NativeParser, R>(
  spec: NativeCliSpec<P, R>,
): Promise<NativeCliRun<R>> {
  return new Promise<NativeCliRun<R>>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = startChild(spec);
    } catch (error) {
      reject(
        new NativeCliError(`Failed to start ${spec.executable}: ${String(error)}`, 'spawn', {
          systemCode: spawnSystemCode(error),
        }),
      );
      return;
    }
    const context: RunContext<P, R> = {
      spec,
      child,
      decoder: new StringDecoder('utf8'),
      limit: spec.maxOutputBytes ?? defaultMaxOutputBytes,
      buffer: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      stderr: '',
      aborted: false,
      settled: false,
      onAbort: () => {},
      resolve,
      reject,
    };
    context.onAbort = () => abortRun(context);
    attach(context);
  });
}

function startChild<P extends NativeParser, R>(spec: NativeCliSpec<P, R>): ChildProcess {
  const invocation = executableInvocation(
    resolveExecutable(spec.executable, {
      platform: spec.platform,
      env: spec.env,
      configuredPath: spec.configuredPath,
    }),
    [...spec.args],
    spec.platform,
    spec.env,
  );
  return (spec.spawn ?? spawn)(invocation.command, invocation.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: spec.platform !== 'win32',
    shell: false,
    stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...invocation.options,
  });
}

function attach<P extends NativeParser, R>(context: RunContext<P, R>): void {
  const { child, spec } = context;
  child.stdout?.on('data', (chunk: Buffer) => consumeStdout(context, chunk));
  child.stderr?.on('data', (chunk: Buffer) => consumeStderr(context, chunk));
  child.once('error', (error) => {
    fail(
      context,
      new NativeCliError(`${spec.executable} failed to start: ${error.message}`, 'spawn', {
        systemCode: spawnSystemCode(error),
      }),
    );
  });
  child.stdin?.on('error', (error: Error) => {
    fail(context, new NativeCliError(`${spec.executable} stdin failed: ${error.message}`, 'spawn'));
  });
  child.once('close', (exitCode, signal) => finishRun(context, exitCode, signal));
  spec.signal.addEventListener('abort', context.onAbort, { once: true });
  if (spec.signal.aborted) {
    context.onAbort();
  }
  if (spec.stdin !== undefined && !spec.parser.failure) {
    child.stdin?.end(spec.stdin);
  }
}

function kill<P extends NativeParser, R>(context: RunContext<P, R>, signal: NodeJS.Signals): void {
  if (context.child.pid) {
    terminateProcessTree(context.child.pid, { platform: context.spec.platform, signal });
  }
}

/** Interrupt first, then terminate, then kill: a CLI may save native state. */
function stop<P extends NativeParser, R>(context: RunContext<P, R>): void {
  kill(context, 'SIGINT');
  context.interruptTimer = setTimeout(() => {
    kill(context, 'SIGTERM');
    context.terminateTimer = setTimeout(() => kill(context, 'SIGKILL'), terminateGraceMs);
  }, interruptGraceMs);
}

function clearTimers<P extends NativeParser, R>(context: RunContext<P, R>): void {
  clearTimeout(context.interruptTimer);
  clearTimeout(context.terminateTimer);
  clearTimeout(context.cancellationTimer);
}

function fail<P extends NativeParser, R>(context: RunContext<P, R>, error: NativeCliError): void {
  if (!context.spec.parser.failure) {
    context.spec.parser.failure = error;
    stop(context);
  }
}

function emitEvent<P extends NativeParser, R>(context: RunContext<P, R>, event: unknown): void {
  try {
    context.spec.onEvent?.(event);
  } catch (error) {
    fail(
      context,
      new NativeCliError(`${context.spec.name} event handler failed: ${String(error)}`, 'parse'),
    );
  }
}

function consumeStdout<P extends NativeParser, R>(context: RunContext<P, R>, chunk: Buffer): void {
  if (context.spec.parser.failure) {
    return;
  }
  context.stdoutBytes += chunk.byteLength;
  if (context.stdoutBytes > context.limit) {
    fail(
      context,
      new NativeCliError(`${context.spec.name} stdout exceeded its safety limit`, 'output_limit'),
    );
    return;
  }
  context.buffer += context.decoder.write(chunk);
  let newline = context.buffer.indexOf('\n');
  while (newline >= 0) {
    const line = context.buffer.slice(0, newline).replace(/\r$/, '');
    context.buffer = context.buffer.slice(newline + 1);
    parse(context, line);
    newline = context.buffer.indexOf('\n');
  }
  if (context.buffer.length > context.limit) {
    fail(
      context,
      new NativeCliError(
        `${context.spec.name} stdout line exceeded its safety limit`,
        'output_limit',
      ),
    );
  }
}

function parse<P extends NativeParser, R>(context: RunContext<P, R>, line: string): void {
  context.spec.parseLine(
    line,
    context.spec.parser,
    (event) => emitEvent(context, event),
    (error) => fail(context, error),
  );
}

function consumeStderr<P extends NativeParser, R>(context: RunContext<P, R>, chunk: Buffer): void {
  if (context.spec.parser.failure) {
    return;
  }
  context.stderrBytes += chunk.byteLength;
  if (context.stderrBytes > context.limit) {
    fail(
      context,
      new NativeCliError(`${context.spec.name} stderr exceeded its safety limit`, 'output_limit'),
    );
    return;
  }
  context.stderr += chunk.toString('utf8');
}

function abortRun<P extends NativeParser, R>(context: RunContext<P, R>): void {
  if (context.aborted) {
    return;
  }
  context.aborted = true;
  context.child.stdin?.destroy();
  context.child.stdout?.destroy();
  context.child.stderr?.destroy();
  stop(context);
  // A child that never reports its own close still settles the run.
  context.cancellationTimer = setTimeout(() => finishRun(context, null, null), cancellationWaitMs);
}

function finishRun<P extends NativeParser, R>(
  context: RunContext<P, R>,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (context.settled) {
    return;
  }
  context.settled = true;
  context.spec.signal.removeEventListener('abort', context.onAbort);
  context.buffer += context.decoder.end();
  if (context.buffer && !context.spec.parser.failure) {
    parse(context, context.buffer);
  }
  clearTimers(context);
  if (context.aborted || context.spec.parser.failure || !context.spec.parser.terminal) {
    kill(context, 'SIGKILL');
  }
  const stderr = redactStderr(context.stderr);
  const final = context.spec.finish(context.spec.parser, context.aborted, exitCode, signal, stderr);
  if (final instanceof NativeCliError) {
    context.reject(final);
    return;
  }
  context.resolve({ result: final, exitCode, signal, stderr });
}

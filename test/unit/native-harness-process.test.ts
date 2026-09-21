import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  cancellationWaitMs,
  defaultMaxOutputBytes,
  interruptGraceMs,
  NativeCliError,
  nativeEnvironment,
  promptArgumentLimitBytes,
  redactStderr,
  runNativeCli,
  terminateGraceMs,
} from '../../plugins/multi-core/src/gateway/harness-process.ts';

type Parser = { lines: string[]; terminal?: string; failure?: NativeCliError };

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
}

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 5));
}

function parseLine(
  line: string,
  parser: Parser,
  emit: (event: unknown) => void,
  fail: (error: NativeCliError) => void,
) {
  if (!line.trim()) {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    fail(new NativeCliError('Invalid native NDJSON event', 'parse'));
    return;
  }
  const event = value as { type?: string; id?: string };
  parser.lines.push(line);
  if (event.type === 'end') {
    parser.terminal = event.id;
  }
  emit(event);
}

function finish(
  parser: Parser,
  aborted: boolean,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): { id: string } | NativeCliError {
  if (parser.failure) {
    return new NativeCliError(parser.failure.message, parser.failure.code, {
      exitCode,
      signal,
      stderr,
    });
  }
  if (parser.terminal) {
    return { id: parser.terminal };
  }
  return new NativeCliError(
    aborted ? 'Native run was canceled before a terminal result' : 'Native run had no result',
    aborted ? 'aborted' : 'no_terminal_result',
    { exitCode, signal, stderr },
  );
}

function start(
  child: FakeChild,
  overrides: {
    parser?: Parser;
    stdin?: string;
    maxOutputBytes?: number;
    signal?: AbortSignal;
    onEvent?: (event: unknown) => void;
    configuredPath?: string;
  } = {},
) {
  const parser: Parser = overrides.parser ?? { lines: [] };
  const spawned: { command?: string; args?: readonly string[]; stdio?: unknown } = {};
  const run = runNativeCli<Parser, { id: string }>({
    name: 'Native',
    executable: 'native',
    configuredPath: overrides.configuredPath ?? process.execPath,
    args: ['-p', 'hello'],
    cwd: path.dirname(process.execPath),
    platform: 'linux',
    env: { PATH: '' },
    signal: overrides.signal ?? new AbortController().signal,
    spawn: (command, args, options) => {
      spawned.command = String(command);
      spawned.args = args as readonly string[];
      spawned.stdio = (options as { stdio?: unknown } | undefined)?.stdio;
      return child as unknown as ChildProcess;
    },
    ...(overrides.maxOutputBytes === undefined ? {} : { maxOutputBytes: overrides.maxOutputBytes }),
    ...(overrides.stdin === undefined ? {} : { stdin: overrides.stdin }),
    parser,
    parseLine,
    ...(overrides.onEvent === undefined ? {} : { onEvent: overrides.onEvent }),
    finish,
  });
  return { run, parser, spawned };
}

test('a native stream is parsed line by line and its stderr is redacted', async () => {
  const child = new FakeChild();
  const events: unknown[] = [];
  const { run, spawned, parser } = start(child, { onEvent: (event) => events.push(event) });
  await flush();
  assert.equal(spawned.command, process.execPath);
  assert.deepEqual(spawned.args, ['-p', 'hello']);
  assert.deepEqual(spawned.stdio, ['ignore', 'pipe', 'pipe']);

  child.stdout.write('{"type":"text","id":"a"}\r\n{"type":"text","id":"b"}\n');
  child.stderr.write('Authorization: Bearer abc123\n');
  await flush();
  // A final line without its newline is still parsed when the process closes.
  child.stdout.write('{"type":"end","id":"run-1"}');
  await flush();
  child.emit('close', 0, null);

  const outcome = await run;
  assert.deepEqual(outcome.result, { id: 'run-1' });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.stderr, 'Authorization: Bearer [redacted]\n');
  assert.equal(parser.lines.length, 3);
  assert.equal(events.length, 3);
});

test('cancellation escalates across the process tree and never invents an answer', async (t) => {
  const signals: (string | number | undefined)[] = [];
  t.mock.method(process, 'kill', (_pid: number, signal?: string | number) => {
    signals.push(signal);
  });
  const child = new FakeChild();
  const controller = new AbortController();
  const { run } = start(child, { signal: controller.signal });
  await flush();
  child.stdout.write('{"type":"text","id":"a"}\n');
  await flush();

  controller.abort(new Error('client left'));
  await flush();
  assert.deepEqual([...new Set(signals)], ['SIGINT']);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);

  const failure = await run.then(
    () => undefined,
    (error: unknown) => error,
  );
  // The child never reported its own close, so the cancellation wait settled it.
  assert.ok(failure instanceof NativeCliError);
  assert.equal(failure.code, 'aborted');
  assert.match(failure.message, /canceled before a terminal result/);
  assert.deepEqual([...new Set(signals)], ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.equal(cancellationWaitMs, interruptGraceMs + terminateGraceMs + 1000);
});

test('an oversized stream stops the run instead of buffering it', async (t) => {
  t.mock.method(process, 'kill', () => {});
  const child = new FakeChild();
  const { run } = start(child, { maxOutputBytes: 64 });
  await flush();
  child.stdout.write(`{"type":"text","id":"${'x'.repeat(200)}"}\n`);
  await flush();
  child.emit('close', 0, null);
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof NativeCliError);
    assert.equal(error.code, 'output_limit');
    assert.match(error.message, /Native stdout exceeded its safety limit/);
    return true;
  });
});

test('a failing event handler and an unreadable line both fail the run', async (t) => {
  t.mock.method(process, 'kill', () => {});
  const child = new FakeChild();
  const { run } = start(child, {
    onEvent: () => {
      throw new Error('observer exploded');
    },
  });
  await flush();
  child.stdout.write('{"type":"text","id":"a"}\n');
  await flush();
  child.emit('close', 0, null);
  await assert.rejects(run, /Native event handler failed: Error: observer exploded/);

  const second = new FakeChild();
  const other = start(second);
  await flush();
  second.stdout.write('{not json}\n');
  await flush();
  second.emit('close', 0, null);
  await assert.rejects(other.run, /Invalid native NDJSON event/);
});

test('a prompt too large for an argument is delivered on stdin', async () => {
  const child = new FakeChild();
  const delivered: string[] = [];
  child.stdin.on('data', (chunk: Buffer) => delivered.push(chunk.toString('utf8')));
  const { run, spawned } = start(child, { stdin: '{"event":"user"}\n' });
  await flush();
  assert.deepEqual(spawned.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(delivered, ['{"event":"user"}\n']);
  child.stdout.write('{"type":"end","id":"run-2"}\n');
  await flush();
  child.emit('close', 0, null);
  assert.deepEqual((await run).result, { id: 'run-2' });
});

test('a CLI that cannot start is reported with the reason the system gave', async (t) => {
  t.mock.method(process, 'kill', () => {});
  const missing = path.join(path.dirname(process.execPath), 'definitely-not-here');
  await assert.rejects(
    start(new FakeChild(), { configuredPath: missing }).run,
    (error: unknown) => {
      assert.ok(error instanceof NativeCliError);
      assert.equal(error.code, 'spawn');
      assert.match(error.message, /Failed to start native/);
      return true;
    },
  );

  const child = new FakeChild();
  const { run } = start(child);
  await flush();
  const failure = Object.assign(new Error('spawn native ENOENT'), { code: 'ENOENT' });
  child.emit('error', failure);
  await flush();
  child.emit('close', null, 'SIGTERM');
  await assert.rejects(run, /native failed to start: spawn native ENOENT/);
});

test('platform limits and a native environment keep other providers out', () => {
  assert.equal(promptArgumentLimitBytes('win32'), 6 * 1024);
  assert.equal(promptArgumentLimitBytes('linux'), 128 * 1024);
  assert.equal(promptArgumentLimitBytes('darwin'), 128 * 1024);
  assert.equal(defaultMaxOutputBytes, 8 * 1024 * 1024);

  const environment = nativeEnvironment({
    overrides: {
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'b',
      CURSOR_API_KEY: 'c',
      GEMINI_API_KEY: 'd',
      MULTI_GATEWAY_TOKEN: 'e',
      NATIVE_API_KEY: 'f',
      HOME: '/home/agent',
    },
    keep: ['NATIVE_API_KEY'],
    drop: ['ANTHROPIC_', 'OPENAI_', 'CURSOR_', 'GEMINI_API_KEY', 'MULTI_GATEWAY_TOKEN'],
    extra: { NO_COLOR: '1' },
  });
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.CURSOR_API_KEY, undefined);
  assert.equal(environment.GEMINI_API_KEY, undefined);
  assert.equal(environment.MULTI_GATEWAY_TOKEN, undefined);
  assert.equal(environment.NATIVE_API_KEY, 'f');
  assert.equal(environment.NO_COLOR, '1');
  assert.equal(environment.HOME, '/home/agent');

  assert.equal(
    redactStderr('Bearer abc123 https://x/y?api_key=zzz&z=1'),
    'Bearer [redacted] https://x/y?api_key=[redacted]&z=1',
  );
  const error = new NativeCliError('stopped', 'aborted', {
    exitCode: 1,
    signal: 'SIGTERM',
    stderr: 'why',
    systemCode: 'EAGAIN',
  });
  assert.equal(error.name, 'NativeCliError');
  assert.deepEqual(
    [error.code, error.exitCode, error.signal, error.stderr, error.systemCode],
    ['aborted', 1, 'SIGTERM', 'why', 'EAGAIN'],
  );
  assert.equal(new NativeCliError('bare', 'parse').systemCode, undefined);
});

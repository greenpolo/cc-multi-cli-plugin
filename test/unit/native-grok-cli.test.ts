import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  GrokCliError,
  type GrokPermissionMode,
  type GrokResult,
  type GrokRunOptions,
  type GrokRunResult,
  type GrokStreamEvent,
  type GrokToolCall,
  type GrokUsage,
  grokEnvironment,
  runGrok,
} from '../../plugins/multi-grok/src/cli.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'grok');

/**
 * One fake CLI for both platforms: Windows resolves it through a `.cmd` shim, POSIX
 * through an executable wrapper, so both executable paths stay covered without two
 * behaviors to keep in step.
 */
const fakeSource = `const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.GROK_ARGS_FILE) {
  fs.writeFileSync(process.env.GROK_ARGS_FILE, args.join('\\n') + '\\n');
}
const fileIndex = args.indexOf('--prompt-file');
if (fileIndex >= 0 && process.env.GROK_PROMPT_COPY) {
  fs.copyFileSync(args[fileIndex + 1], process.env.GROK_PROMPT_COPY);
}
const mode = process.env.GROK_MODE || 'fixture';
if (mode === 'invalid') {
  console.log('{not-json}');
} else if (mode === 'large') {
  process.stdout.write('x'.repeat(20000));
} else if (mode === 'hang') {
  console.log(JSON.stringify({ type: 'text', data: 'partial' }));
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(fs.readFileSync(process.env.GROK_FIXTURE, 'utf8'));
}
if (mode !== 'hang') {
  console.error('diagnostic');
  process.exit(Number(process.env.GROK_EXIT || 0));
}
`;

async function fakeCli(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grok-cli-'));
  const body = path.join(directory, 'grok-fixture.cjs');
  await writeFile(body, fakeSource, 'utf8');
  const executable = path.join(directory, process.platform === 'win32' ? 'grok.cmd' : 'grok');
  if (process.platform === 'win32') {
    await writeFile(executable, `@echo off\r\n"${process.execPath}" "${body}" %*\r\n`, 'utf8');
  } else {
    await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${body}" "$@"\n`, 'utf8');
    await chmod(executable, 0o700);
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { cwd: directory, executable };
}

function isCliError(error: unknown): error is GrokCliError {
  return error instanceof GrokCliError;
}

function replay(
  cli: { cwd: string; executable: string },
  fixture: string,
  extra: Partial<GrokRunOptions> = {},
  env: NodeJS.ProcessEnv = {},
) {
  const options: GrokRunOptions = {
    cwd: cli.cwd,
    executable: cli.executable,
    prompt: 'hello',
    signal: AbortSignal.timeout(20000),
    env: { GROK_FIXTURE: path.join(fixtures, fixture), ...env },
    ...extra,
  };
  return runGrok(options);
}

test('replays a recorded text run and rebuilds the response from its deltas', async (t) => {
  const cli = await fakeCli(t);
  const events: GrokStreamEvent[] = [];
  const output: GrokRunResult = await replay(cli, 'text-only.jsonl', {
    onEvent: (event) => events.push(event),
  });

  const result: GrokResult = output.result;
  assert.equal(result.sessionId, '01a0bdb4-a4df-7102-bcc7-d39760ae9689');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.turns, 1);
  assert.equal(result.costUsd, 0.01748756);
  const usage: GrokUsage | undefined = result.usage;
  assert.equal(usage?.total_tokens, 33323);
  assert.equal(usage?.cache_read_input_tokens, 10496);
  // The terminal event carries no text, so the answer only exists as accumulated deltas.
  assert.equal(output.response, 'OK');
  assert.equal(output.exitCode, 0);
  assert.equal(output.stderr, 'diagnostic\n');
  assert.deepEqual(
    [...new Set(events.map((event) => event.event))],
    ['tools', 'thought', 'text', 'usage', 'result'],
  );
  // The CLI repeats one toolset, then announces a larger one; only changes surface.
  const announcements = events.filter((event) => event.event === 'tools');
  assert.deepEqual(
    announcements.map((event) => (event.event === 'tools' ? event.tools.length : 0)),
    [27, 90],
  );
});

test('reports a natively denied tool as provider display state', async (t) => {
  const cli = await fakeCli(t);
  const calls: GrokToolCall[] = [];
  const output = await replay(cli, 'tool-denied-by-rule.jsonl', {
    onEvent: (event) => {
      if (event.event === 'tool_call' || event.event === 'tool_update') {
        calls.push(event.call);
      }
    },
  });

  assert.equal(output.result.stopReason, 'end_turn');
  assert.equal(
    calls.filter((call) => call.toolName === 'run_terminal_command' && call.status === 'pending')
      .length,
    2,
  );
  const failed = calls.filter((call) => call.status === 'failed');
  assert.equal(failed.length, 2);
  assert.match(JSON.stringify(failed[0].content), /Denied by permission policy/);
  assert.match(output.response, /denied by permission policy/i);
});

test('fails the run when the CLI silently ignores a tool policy', async (t) => {
  const cli = await fakeCli(t);
  // `--disallowed-tools run_terminal_command` was accepted and ignored; the announced
  // toolset is the only place that shows the removal never took effect.
  await assert.rejects(
    replay(cli, 'disallowed-tools-ignored.jsonl', {
      disallowedTools: ['run_terminal_command'],
      forbiddenTools: ['run_terminal_command'],
    }),
    (error: unknown) =>
      isCliError(error) &&
      error.code === 'policy' &&
      /run_terminal_command remains available/.test(error.message),
  );
});

test('tolerates the toolset growing as MCP servers connect', async (t) => {
  const cli = await fakeCli(t);
  const announcements: (readonly string[])[] = [];
  const output = await replay(cli, 'session-create.jsonl', {
    tools: ['read_file', 'list_dir', 'grep'],
    forbiddenTools: ['run_terminal_command', 'write', 'spawn_subagent'],
    onEvent: (event) => {
      if (event.event === 'tools') {
        announcements.push(event.tools);
      }
    },
  });

  assert.deepEqual(announcements[0], ['read_file', 'list_dir', 'grep', 'search_tool', 'use_tool']);
  // Measured: the `--tools` allowlist bounds built-ins only. MCP tools are added to
  // the model's toolset once their servers connect, so exposure is deny-gated, not
  // prevented, and the growth must never be mistaken for a policy breach.
  assert.equal(announcements.length, 2);
  assert.equal(announcements[1].filter((tool) => tool.includes('__')).length, 63);
  assert.equal(output.result.sessionId, 'f6e4b375-8213-4b5e-993d-f546b91362e4');
  assert.equal(output.response, 'STORED');
});

test('fails closed on an announced tool that is neither granted nor MCP', async (t) => {
  const cli = await fakeCli(t);
  // A native tool this build adds later is not on the forbidden list, but it was never granted.
  await assert.rejects(
    replay(cli, 'text-only.jsonl', {
      tools: ['read_file', 'list_dir', 'grep'],
      forbiddenTools: [],
    }),
    (error: unknown) =>
      isCliError(error) && error.code === 'policy' && /remains available/.test(error.message),
  );
});

test('never infers a result when the stream stops without its terminal event', async (t) => {
  const cli = await fakeCli(t);
  await assert.rejects(
    replay(cli, 'cancelled-no-terminal.jsonl'),
    (error: unknown) => isCliError(error) && error.code === 'no_terminal_result',
  );
});

test('sends explicit flags and refuses to both create and resume a session', async (t) => {
  const cli = await fakeCli(t);
  const argsFile = path.join(cli.cwd, 'args.txt');
  const mode: GrokPermissionMode = 'plan';
  await replay(
    cli,
    // The announced toolset must be the requested one, so the fixture's own tools are granted.
    'session-create.jsonl',
    {
      model: 'grok-4.6',
      effort: 'high',
      mode,
      session: 'f6e4b375-8213-4b5e-993d-f546b91362e4',
      tools: ['read_file', 'list_dir', 'grep'],
      disallowedTools: ['search_tool', 'use_tool'],
      allow: ['Read(**)'],
      deny: ['Bash(*)', 'MCPTool(*)'],
    },
    { GROK_ARGS_FILE: argsFile },
  );

  const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
  assert.equal(args[0], '-p');
  assert.equal(args[args.indexOf('--output-format') + 1], 'streaming-json');
  assert.equal(args.includes('--no-auto-update'), true);
  assert.equal(args[args.indexOf('--model') + 1], 'grok-4.6');
  assert.equal(args[args.indexOf('--reasoning-effort') + 1], 'high');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(args[args.indexOf('--session-id') + 1], 'f6e4b375-8213-4b5e-993d-f546b91362e4');
  assert.equal(args.includes('--resume'), false);
  assert.equal(args[args.indexOf('--tools') + 1], 'read_file,list_dir,grep');
  assert.equal(args[args.indexOf('--disallowed-tools') + 1], 'search_tool,use_tool');
  assert.deepEqual(
    args.flatMap((value, index) => (args[index - 1] === '--deny' ? [value] : [])),
    ['Bash(*)', 'MCPTool(*)'],
  );
  assert.equal(args[args.indexOf('--cwd') + 1], cli.cwd);

  await assert.rejects(
    replay(cli, 'text-only.jsonl', { session: 'new-id', resume: 'old-id' }),
    (error: unknown) => isCliError(error) && error.code === 'spawn',
  );
});

test('a CLI that cannot start reports the operating system reason', async (t) => {
  const cli = await fakeCli(t);
  // The classification upstream turns on this code: a missing binary is permanent,
  // a machine momentarily out of processes is not.
  await assert.rejects(
    replay(cli, 'text-only.jsonl', {
      executable: path.join(cli.cwd, 'absent', 'grok'),
    }),
    (error: unknown) =>
      isCliError(error) && error.code === 'spawn' && error.systemCode === 'ENOENT',
  );
});

test('resumes an existing session without claiming a new identity', async (t) => {
  const cli = await fakeCli(t);
  const argsFile = path.join(cli.cwd, 'args.txt');
  const output = await replay(
    cli,
    'session-resume.jsonl',
    { resume: 'f6e4b375-8213-4b5e-993d-f546b91362e4' },
    { GROK_ARGS_FILE: argsFile },
  );
  const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
  assert.equal(args[args.indexOf('--resume') + 1], 'f6e4b375-8213-4b5e-993d-f546b91362e4');
  assert.equal(args.includes('--session-id'), false);
  assert.equal(output.result.sessionId, 'f6e4b375-8213-4b5e-993d-f546b91362e4');
  assert.equal(output.response, 'ZQ-4417');
});

test('passes an oversized prompt through a file and removes it afterwards', async (t) => {
  const cli = await fakeCli(t);
  const argsFile = path.join(cli.cwd, 'args.txt');
  const copy = path.join(cli.cwd, 'prompt-copy.txt');
  const prompt = `long ${'x'.repeat(200 * 1024)}`;
  await replay(
    cli,
    'text-only.jsonl',
    { prompt },
    { GROK_ARGS_FILE: argsFile, GROK_PROMPT_COPY: copy },
  );

  const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
  assert.equal(args[0], '--prompt-file');
  assert.equal(args.includes('-p'), false);
  assert.equal(await readFile(copy, 'utf8'), prompt);
  await assert.rejects(stat(args[1]));
});

async function grokSpawnArguments(
  launcher: string,
  prompt: string,
  platform: NodeJS.Platform,
): Promise<readonly string[]> {
  let spawned: readonly string[] = [];
  await runGrok({
    cwd: path.dirname(launcher),
    executable: launcher,
    prompt,
    platform,
    signal: AbortSignal.timeout(2000),
    spawn: ((_command: string, args?: readonly string[]) => {
      spawned = args ?? [];
      throw Object.assign(new Error('stop'), { code: 'ENOENT' });
    }) as unknown as GrokRunOptions['spawn'],
  }).catch(() => undefined);
  return spawned;
}

test('a prompt with cmd metacharacters goes through a file on a non-shim .cmd launcher on Windows', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grok-cmd-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const launcher = path.join(directory, 'grok.cmd');
  await writeFile(launcher, '@echo off\r\nrem not an npm shim\r\n');
  for (const prompt of ['say "hi"', '100% done', 'a & b']) {
    const spawned = await grokSpawnArguments(launcher, prompt, 'win32');
    assert.equal(spawned.join(' ').includes('--prompt-file'), true);
    assert.equal(spawned.join(' ').includes(prompt), false);
  }
  const plain = await grokSpawnArguments(launcher, 'plain', 'win32');
  assert.equal(plain.join(' ').includes('-p plain'), true);
  const posix = await grokSpawnArguments(launcher, 'say "hi"', 'linux');
  assert.deepEqual(posix.slice(0, 2), ['-p', 'say "hi"']);
});

test('refuses unreadable output and bounds what it buffers', async (t) => {
  const cli = await fakeCli(t);
  await assert.rejects(
    replay(cli, 'text-only.jsonl', {}, { GROK_MODE: 'invalid' }),
    (error: unknown) => isCliError(error) && error.code === 'parse',
  );
  await assert.rejects(
    replay(cli, 'text-only.jsonl', { maxOutputBytes: 1000 }, { GROK_MODE: 'large' }),
    (error: unknown) => isCliError(error) && error.code === 'output_limit',
  );
});

test('treats a terminal result with a failed exit as unusable', async (t) => {
  const cli = await fakeCli(t);
  await assert.rejects(
    replay(cli, 'text-only.jsonl', {}, { GROK_EXIT: '3' }),
    (error: unknown) => isCliError(error) && error.code === 'parse' && error.exitCode === 3,
  );
});

test('cancellation stops the native run instead of inventing an answer', async (t) => {
  const cli = await fakeCli(t);
  const controller = new AbortController();
  const pending = replay(
    cli,
    'text-only.jsonl',
    { signal: controller.signal },
    { GROK_MODE: 'hang' },
  );
  controller.abort();
  await assert.rejects(pending, (error: unknown) => isCliError(error) && error.code === 'aborted');
});

test('keeps other providers credentials and metered xAI keys out of the CLI', () => {
  const environment = grokEnvironment({
    XAI_API_KEY: 'xai-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    OPENAI_API_KEY: 'openai-secret',
    CURSOR_API_KEY: 'cursor-secret',
    OPENCODE_API_KEY: 'zen-secret',
    MULTI_GATEWAY_TOKEN: 'gateway-secret',
    GROK_OIDC_ISSUER: 'https://acme.okta.com',
  });
  assert.equal(environment.XAI_API_KEY, undefined);
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.CURSOR_API_KEY, undefined);
  assert.equal(environment.OPENCODE_API_KEY, undefined);
  assert.equal(environment.MULTI_GATEWAY_TOKEN, undefined);
  // Enterprise SSO configuration belongs to the CLI and stays untouched.
  assert.equal(environment.GROK_OIDC_ISSUER, 'https://acme.okta.com');
  assert.equal(environment.NO_COLOR, '1');
});

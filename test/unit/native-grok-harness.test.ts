import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import type { GrokRunOptions, GrokRunResult } from '../../plugins/multi-grok/src/cli.ts';
import { GrokCliError } from '../../plugins/multi-grok/src/cli.ts';
import { GrokHarness, GrokProviderError } from '../../plugins/multi-grok/src/harness.ts';
import type { GrokModel } from '../../plugins/multi-grok/src/models.ts';
import { grokPermissionPolicy } from '../../plugins/multi-grok/src/permissions.ts';

const model: GrokModel = {
  id: 'grok-4.6',
  model: 'multi/grok/grok-4.6',
  label: 'Grok 4.6',
  worker: 'grok-4-6',
  default: true,
};

const context: PermissionContext = { permissionMode: 'auto', cwd: process.cwd() };
const policy = async (_cwd: string, value: PermissionContext) => grokPermissionPolicy(value);

function terminal(overrides: Partial<GrokRunResult['result']> = {}): GrokRunResult {
  return {
    result: {
      sessionId: overrides.sessionId ?? 'unused',
      stopReason: 'end_turn',
      usage: { input_tokens: 40, output_tokens: 9, reasoning_tokens: 3, total_tokens: 49 },
      turns: 1,
      costUsd: 0.0175,
      ...overrides,
    },
    response: 'native',
    exitCode: 0,
    signal: null,
    stderr: '',
  };
}

/** Answer on whichever session the harness asked for, as the real CLI does. */
function echoSession(options: GrokRunOptions, overrides: Partial<GrokRunResult['result']> = {}) {
  return terminal({ sessionId: options.resume ?? options.session ?? 'unknown', ...overrides });
}

async function setup(t: test.TestContext) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'grok-harness-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const calls: GrokRunOptions[] = [];
  return { stateDirectory, calls };
}

function ask(harness: GrokHarness, content: string, scope = 'worker') {
  return harness.handle(
    { model: model.model, messages: [{ role: 'user', content }] },
    scope,
    new AbortController().signal,
    undefined,
    context,
  );
}

test('reports native usage, model and effort on the Messages response', async (t) => {
  const { stateDirectory } = await setup(t);
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => echoSession(options),
  });
  t.after(() => harness.close());

  const response = await harness.handle(
    {
      model: model.model,
      messages: [{ role: 'user', content: 'usage' }],
      output_config: { effort: 'high' },
    },
    'usage',
    new AbortController().signal,
    undefined,
    context,
  );

  assert.deepEqual(response.usage, { input_tokens: 40, output_tokens: 9 });
  assert.deepEqual(response.multi_usage, {
    source: 'provider',
    reasoning_tokens: 3,
    total_tokens: 49,
    model: 'grok-4.6',
    effort: 'high',
  });
});

test('creates its own session identity and sends the policy with the run', async (t) => {
  const { stateDirectory, calls } = await setup(t);
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => {
      calls.push(options);
      options.onEvent?.({ event: 'text', text: 'hello' });
      return echoSession(options);
    },
  });
  t.after(() => harness.close());

  await ask(harness, 'first');

  assert.equal(calls.length, 1);
  assert.match(String(calls[0].session), /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].resume, undefined);
  assert.equal(calls[0].mode, 'auto');
  assert.deepEqual(calls[0].deny, ['MCPTool(*)']);
  assert.equal(calls[0].disallowedTools?.[0], 'Agent');
  assert.equal(calls[0].disallowedTools?.includes('spawn_subagent'), true);
  assert.equal(calls[0].tools?.includes('run_terminal_command'), true);
  // The forbidden list is what the CLI stream is checked against.
  assert.equal(calls[0].forbiddenTools?.includes('spawn_subagent'), true);
});

test('resumes the recorded session and forwards only the newest turn', async (t) => {
  const { stateDirectory, calls } = await setup(t);
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => {
      calls.push(options);
      options.onEvent?.({ event: 'text', text: 'answered' });
      return echoSession(options);
    },
  });
  t.after(() => harness.close());

  const first: MessagesResponse = await ask(harness, 'first question');
  const second = await harness.handle(
    {
      model: model.model,
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: first.content },
        { role: 'user', content: 'second question' },
      ],
    },
    'worker',
    new AbortController().signal,
    undefined,
    context,
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].resume, calls[0].session);
  assert.equal(calls[1].session, undefined);
  assert.match(calls[1].prompt, /second question/);
  assert.equal(calls[1].prompt.includes('first question'), false);
  // A stable policy is announced once, not on every turn.
  assert.equal(text(second).includes('Claude Code rules take precedence'), false);
});

test('a continuation error releases the session instead of leaving it busy', async (t) => {
  const { stateDirectory, calls } = await setup(t);
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => {
      calls.push(options);
      options.onEvent?.({ event: 'text', text: 'answered' });
      return echoSession(options);
    },
  });
  t.after(() => harness.close());

  const first: MessagesResponse = await ask(harness, 'first question');

  // No message follows the last assistant turn, so `continuation` throws before any
  // native run starts. That must still release the record: a busy flag left set by
  // the throw would refuse every later request on this agent forever.
  await assert.rejects(
    harness.handle(
      {
        model: model.model,
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: first.content },
        ],
      },
      'worker',
      new AbortController().signal,
      undefined,
      context,
    ),
    /continuation requires a message/,
  );
  assert.equal(calls.length, 1, 'the rejected continuation must not start a native run');

  await ask(harness, 'still works');
  assert.equal(calls.length, 2, 'the session was released, so a later request runs normally');
});

test('displays native tool activity as text instead of replaying it', async (t) => {
  const { stateDirectory } = await setup(t);
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => {
      options.onEvent?.({
        event: 'tool_call',
        call: { toolCallId: 'call-1', toolName: 'run_terminal_command', status: 'pending' },
      });
      options.onEvent?.({
        event: 'tool_update',
        call: {
          toolCallId: 'call-1',
          status: 'failed',
          content: [{ content: { type: 'text', text: 'Denied by permission policy: deny rule' } }],
        },
      });
      options.onEvent?.({
        event: 'tool_update',
        call: {
          toolCallId: 'call-2',
          status: 'failed',
          content: [{ content: { type: 'text', text: 'Error: note.txt does not exist' } }],
        },
      });
      options.onEvent?.({ event: 'text', text: 'I could not run it.' });
      return echoSession(options);
    },
  });
  t.after(() => harness.close());

  const response = await ask(harness, 'run something');
  assert.deepEqual([...new Set(response.content.map((block) => block.type))], ['text']);
  assert.match(text(response), /\[Grok\] run_terminal_command/);
  assert.match(text(response), /\[Grok\] refused: Denied by permission policy/);
  // An ordinary tool error is not a permission decision and must not read as one.
  assert.match(text(response), /\[Grok\] failed: Error: note\.txt does not exist/);
  assert.match(text(response), /I could not run it\./);
  assert.match(text(response), /\$0\.0175 billed/);
});

test('replays a completed identical request instead of running it twice', async (t) => {
  const { stateDirectory, calls } = await setup(t);
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => {
      calls.push(options);
      options.onEvent?.({ event: 'text', text: 'once' });
      return echoSession(options);
    },
  });
  t.after(() => harness.close());

  const first = await ask(harness, 'same question');
  const replayed = await ask(harness, 'same question');

  assert.equal(calls.length, 1);
  assert.equal(replayed.multi_usage?.replayed, true);
  assert.equal(text(replayed), text(first));
});

test('an interrupted run resumes with a notice instead of repeating actions', async (t) => {
  const { stateDirectory, calls } = await setup(t);
  let fail = true;
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => {
      calls.push(options);
      options.onEvent?.({ event: 'text', text: 'partial' });
      if (fail) {
        throw new Error('Grok exited without a terminal result');
      }
      return echoSession(options);
    },
  });
  t.after(() => harness.close());

  await assert.rejects(ask(harness, 'do the work'), GrokProviderError);
  const saved = await session(stateDirectory);
  assert.equal(saved.interrupted, true);
  assert.match(String(saved.sessionId), /^[0-9a-f-]{36}$/);

  fail = false;
  const recovered = await ask(harness, 'what happened');
  assert.equal(calls[1].resume, calls[0].session);
  assert.match(calls[1].prompt, /previous turn was interrupted/);
  assert.match(text(recovered), /previous turn was interrupted/);
  assert.equal((await session(stateDirectory)).interrupted, false);
});

test('a run that never started leaves no native session behind', async (t) => {
  const { stateDirectory, calls } = await setup(t);
  let fail = true;
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => {
      calls.push(options);
      if (fail) {
        throw new Error('Failed to start grok');
      }
      return echoSession(options);
    },
  });
  t.after(() => harness.close());

  await assert.rejects(ask(harness, 'start'), GrokProviderError);
  // Nothing was persisted: an identity is only recorded once the CLI has spoken.
  assert.equal(await sessionFile(stateDirectory), undefined);

  fail = false;
  await ask(harness, 'start again');
  assert.equal(calls[1].resume, undefined);
  assert.match(String(calls[1].session), /^[0-9a-f-]{36}$/);
  assert.equal((await session(stateDirectory)).sessionId, calls[1].session);
});

test('refuses an answer that arrives on another native session', async (t) => {
  const { stateDirectory } = await setup(t);
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => {
      options.onEvent?.({ event: 'text', text: 'hello' });
      return terminal({ sessionId: 'a-different-session' });
    },
  });
  t.after(() => harness.close());

  await assert.rejects(ask(harness, 'whose session'), (error: unknown) => {
    assert.equal(error instanceof GrokProviderError, true);
    assert.match(String(error), /answered on session a-different-session/);
    return true;
  });
});

test('a compaction turn runs without any workspace tool', async (t) => {
  const { stateDirectory, calls } = await setup(t);
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => {
      calls.push(options);
      return echoSession(options);
    },
  });
  t.after(() => harness.close());

  await harness.handle(
    { model: model.model, messages: [{ role: 'user', content: 'summarize' }] },
    'compaction',
    new AbortController().signal,
    undefined,
    { ...context, compaction: 'compact-1' },
  );

  assert.deepEqual(calls[0].tools, ['todo_write']);
  assert.equal(calls[0].deny?.includes('Read(*)'), true);
  assert.equal(calls[0].mode, 'plan');
});

test('an unsupported permission mode fails before the CLI starts', async (t) => {
  const { stateDirectory, calls } = await setup(t);
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => {
      calls.push(options);
      return echoSession(options);
    },
  });
  t.after(() => harness.close());

  await assert.rejects(
    harness.handle(
      { model: model.model, messages: [{ role: 'user', content: 'go' }] },
      'unsupported',
      new AbortController().signal,
      undefined,
      { ...context, permissionMode: 'default' },
    ),
    /unsupported/,
  );
  assert.equal(calls.length, 0);
});

test('a policy the CLI did not apply fails the request instead of retrying', async (t) => {
  const { stateDirectory } = await setup(t);
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => {
      options.onEvent?.({ event: 'text', text: 'partial' });
      throw new GrokCliError('Grok did not apply the session tool policy: write remains', 'policy');
    },
  });
  t.after(() => harness.close());

  await assert.rejects(ask(harness, 'go'), (error: unknown) => {
    assert.equal(error instanceof GrokProviderError, true);
    // 502 had Claude retry a paid run ten times over one deterministic refusal.
    assert.equal((error as GrokProviderError).failure.status, 400);
    return true;
  });
});

test('a CLI the machine could not start stays retryable, a missing one does not', async (t) => {
  const { stateDirectory } = await setup(t);
  const failures = [
    new GrokCliError('grok failed to start: spawn EAGAIN', 'spawn', { systemCode: 'EAGAIN' }),
    new GrokCliError('grok failed to start: spawn grok ENOENT', 'spawn', { systemCode: 'ENOENT' }),
  ];
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async () => {
      throw failures.shift() ?? new Error('no failure left');
    },
  });
  t.after(() => harness.close());

  // Nothing ran, so nothing was paid for: a machine out of processes is worth
  // another attempt, unlike a binary that is not there.
  await assert.rejects(ask(harness, 'out of processes'), (error: unknown) => {
    assert.equal((error as GrokProviderError).failure.status, 502);
    return true;
  });
  await assert.rejects(ask(harness, 'no binary'), (error: unknown) => {
    assert.equal((error as GrokProviderError).failure.status, 400);
    assert.match((error as GrokProviderError).message, /make grok available on PATH/);
    return true;
  });
});

test('failure advice reads a status, not a number that resembles one', () => {
  const advised = (message: string) => new GrokProviderError(new Error(message)).message;

  assert.match(advised('Request failed with status code 401'), /grok login/);
  assert.match(advised('401 Unauthorized'), /grok login/);
  assert.match(advised('HTTP 429 Too Many Requests'), /rate limited/);
  // Sending someone to re-login over a line count is worse than saying nothing.
  assert.equal(advised('Rewrote 401 lines of grok-429.log'), 'Rewrote 401 lines of grok-429.log');
});

test('a prompt sent during a run is refused instead of resuming stale history', async (t) => {
  const { stateDirectory, calls } = await setup(t);
  const release = Promise.withResolvers<void>();
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => {
      calls.push(options);
      options.onEvent?.({ event: 'text', text: 'working' });
      if (calls.length === 1) {
        await release.promise;
      }
      return echoSession(options);
    },
  });
  t.after(async () => {
    release.resolve();
    await harness.close();
  });

  const first = ask(harness, 'long running');
  await until(() => calls.length === 1);

  // This prompt was written before the answer existed, so its history stops at the
  // running turn; resuming with it would send that turn to the CLI a second time.
  await assert.rejects(
    harness.handle(
      {
        model: model.model,
        messages: [
          { role: 'user', content: 'long running' },
          { role: 'user', content: 'typed while busy' },
        ],
      },
      'worker',
      new AbortController().signal,
      undefined,
      context,
    ),
    (error: unknown) => {
      assert.equal(error instanceof GrokProviderError, true);
      assert.match((error as GrokProviderError).message, /already running/);
      // Deterministic while the run lasts: a retryable status turned one conflict
      // into ten attempts in a live session.
      assert.equal((error as GrokProviderError).failure.status, 400);
      return true;
    },
  );
  assert.equal(calls.length, 1, 'the refused prompt must not start a native run');

  release.resolve();
  await first;

  // The run in flight is untouched, and the next prompt resumes the session it opened.
  await ask(harness, 'after the refusal');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].resume, calls[0].session);
});

test('a closed harness refuses new work', async (t) => {
  const { stateDirectory } = await setup(t);
  const harness = new GrokHarness([model], {
    stateDirectory,
    checkPermissions: policy,
    run: async (options) => echoSession(options),
  });
  await harness.close();
  await assert.rejects(ask(harness, 'too late'), /closed/);
});

function text(response: MessagesResponse): string {
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the first run to start');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sessionFile(stateDirectory: string) {
  const files = await readdir(stateDirectory);
  return files.find((name) => name.endsWith('.session.json'));
}

async function session(stateDirectory: string) {
  const file = await sessionFile(stateDirectory);
  assert.notEqual(file, undefined);
  return JSON.parse(await readFile(path.join(stateDirectory, String(file)), 'utf8'));
}

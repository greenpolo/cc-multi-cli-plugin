import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import type { AgentOptions, Run, RunResult, SDKUserMessage, SendOptions } from '@cursor/sdk';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import {
  type CreateCursorHarnessAgent,
  CursorHarness,
} from '../../plugins/multi-cursor/src/harness.ts';
import { cursorModelOptions } from '../../plugins/multi-cursor/src/models.ts';
import { CURSOR_TOOLS } from '../../plugins/multi-cursor/src/progress.ts';
import { removeTemporary } from '../temporary.ts';

const options = cursorModelOptions([{ id: 'test-model', displayName: 'Test Model' }]);

test('Cursor harness serves isolated main and worker SSE progress without replaying native work', async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cursor-harness-http-')));
  let sends = 0;
  const createAgent: CreateCursorHarnessAgent = async (_config: AgentOptions) => {
    const agentId = `agent-${sends + 1}`;
    return {
      agentId,
      close() {},
      async send(_prompt: string | SDKUserMessage, options?: SendOptions): Promise<Run> {
        sends++;
        await setTimeout(30);
        await options?.onDelta?.({ update: { type: 'summary-started' } });
        await options?.onDelta?.({
          update: {
            type: 'tool-call-started',
            callId: 'shell',
            modelCallId: 'model',
            toolCall: { type: 'shell', args: { command: 'printf native' } },
          },
        });
        await options?.onDelta?.({ update: { type: 'text-delta', text: 'native result' } });
        await options?.onDelta?.({
          update: {
            type: 'tool-call-completed',
            callId: 'shell',
            modelCallId: 'model',
            toolCall: {
              type: 'shell',
              args: { command: 'printf native' },
              result: {
                status: 'success',
                value: { exitCode: 0, signal: '', stdout: '', stderr: '', executionTime: 1 },
              },
            },
          },
        });
        await options?.onDelta?.({ update: { type: 'summary-completed' } });
        return {
          id: `run-${sends}`,
          agentId,
          status: 'finished',
          wait: async () => ({ id: `run-${sends}`, status: 'finished', result: 'native result' }),
          cancel: async () => {},
          async *stream() {},
          conversation: async () => [],
          supports: () => true,
          unsupportedReason: () => undefined,
          onDidChangeStatus: () => () => {},
        };
      },
    };
  };
  const harness = new CursorHarness(options, {
    cwd: directory,
    stateDirectory: path.join(directory, 'state'),
    createAgent,
  });
  const permissionModes = new PermissionModes(async () => ({ worker: {} }));
  for (const session_id of ['session-1', 'session-cancelled']) {
    await permissionModes.record({
      hook_event_name: 'UserPromptSubmit',
      session_id,
      permission_mode: 'auto',
    });
  }
  await permissionModes.record({
    hook_event_name: 'SubagentStart',
    session_id: 'session-1',
    agent_id: 'worker-1',
    agent_type: 'worker',
    cwd: directory,
  });
  const server = createNativeGateway({
    permissionModes,
    token: 'test-token',
    authFile: 'unused',
    cursor: harness,
    displayTools: { cursor: CURSOR_TOOLS },
    timeoutMs: 5,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await harness.close();
    await removeTemporary(directory);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const request = (agentId?: string) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-multi-gateway-token': 'test-token',
        'x-claude-code-session-id': 'session-1',
        ...(agentId ? { 'x-claude-code-agent-id': agentId } : {}),
      },
      body: JSON.stringify({
        model: options[0].model,
        messages: [{ role: 'user', content: 'Use native tools and report completion.' }],
        stream: true,
      }),
    });

  const first = await request();
  assert.equal(first.status, 200);
  // A whole Cursor run outlives the configured single-model request deadline.
  const firstSse = await first.text();
  assert.match(firstSse, /\[Cursor\] Compacting context/);
  assert.match(firstSse, /\[Cursor\] 1 native action: 1 shell\./);
  assert.doesNotMatch(firstSse, /started\.|completed \(exit/);
  assert.match(firstSse, /\[Cursor\] Context compacted/);
  assert.match(firstSse, /event: message_stop/);
  assert.doesNotMatch(firstSse, /tool_use/);
  const expectShellAction = async (agent: string) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/multi/mod/lifecycle?sessionId=session-1&agentId=${agent}`,
      { headers: { 'x-multi-gateway-token': 'test-token' } },
    );
    assert.equal(response.status, 200);
    const status = (await response.json()) as { state: string; detail: string };
    assert.equal(status.state, 'completed');
    assert.equal(status.detail, 'Shell: printf native');
  };
  await expectShellAction('main');

  const retry = await request();
  assert.equal(retry.status, 200);
  assert.equal(await retry.text(), firstSse);
  assert.equal(sends, 1, 'identical HTTP retry must replay the cached response');

  // Once the mod registered the display tools, the worker's own stream carries the
  // native action as a row named after Cursor's tool, with its native arguments.
  const acknowledged = await fetch(`http://127.0.0.1:${address.port}/multi/mod/display-tools`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-multi-gateway-token': 'test-token' },
    body: JSON.stringify({ sessionId: 'session-1', registered: ['shell'] }),
  });
  assert.equal(acknowledged.status, 200);
  const worker = await request('worker-1');
  assert.equal(worker.status, 200);
  const workerSse = await worker.text();
  assert.match(workerSse, /event: message_stop/);
  assert.match(workerSse, /"name":"mcp__multi-core__shell"/);
  assert.match(workerSse, /\\"command\\":\\"printf native\\"/);
  assert.doesNotMatch(workerSse, /1 native action/, 'the summary waits for the follow-up');
  assert.equal(sends, 2, 'worker scope must own a separate native agent');
  await expectShellAction('worker-1');
});

test('native SSE cancellation stops the SDK run without reporting successful completion', {
  timeout: 5000,
}, async (t) => {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'cursor-harness-http-cancel-')),
  );
  const result = Promise.withResolvers<RunResult>();
  const started = Promise.withResolvers<void>();
  let sends = 0;
  let cancellations = 0;
  const harness = new CursorHarness(options, {
    cwd: directory,
    stateDirectory: path.join(directory, 'state'),
    createAgent: async () => ({
      agentId: 'cancelled-agent',
      close() {},
      async send(_prompt, sendOptions): Promise<Run> {
        sends++;
        await sendOptions?.onDelta?.({
          update: {
            type: 'tool-call-started',
            callId: 'shell',
            modelCallId: 'model',
            toolCall: { type: 'shell', args: { command: 'printf native' } },
          },
        });
        return {
          id: 'cancelled-run',
          agentId: 'cancelled-agent',
          status: 'running',
          wait: () => {
            started.resolve();
            return result.promise;
          },
          cancel: async () => {
            cancellations++;
            result.resolve({ id: 'cancelled-run', status: 'cancelled' });
          },
          async *stream() {},
          conversation: async () => [],
          supports: () => true,
          unsupportedReason: () => undefined,
          onDidChangeStatus: () => () => {},
        };
      },
    }),
  });
  const permissionModes = new PermissionModes(async () => ({ worker: {} }));
  for (const session_id of ['session-1', 'session-cancelled']) {
    await permissionModes.record({
      hook_event_name: 'UserPromptSubmit',
      session_id,
      permission_mode: 'auto',
    });
  }
  await permissionModes.record({
    hook_event_name: 'SubagentStart',
    session_id: 'session-1',
    agent_id: 'worker-1',
    agent_type: 'worker',
    cwd: directory,
  });
  const server = createNativeGateway({
    permissionModes,
    token: 'test-token',
    authFile: 'unused',
    cursor: harness,
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await harness.close();
    await removeTemporary(directory);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const request = () =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-multi-gateway-token': 'test-token',
        'x-claude-code-session-id': 'session-cancelled',
      },
      body: JSON.stringify({
        model: options[0].model,
        messages: [{ role: 'user', content: 'Use native tools.' }],
        stream: true,
      }),
    });
  const response = await request();
  assert.equal(response.status, 200);
  await started.promise;
  await harness.close();
  const sse = await response.text();
  assert.equal(cancellations, 1);
  assert.doesNotMatch(sse, /\[Cursor\] Shell: printf native started/);
  assert.match(sse, /event: error/);
  assert.doesNotMatch(sse, /event: message_stop|"stop_reason":"end_turn"|tool_use/);
  const retry = await request();
  assert.doesNotMatch(await retry.text(), /event: message_stop|tool_use/);
  assert.equal(sends, 1);
});

test('a prompt that arrives during a native run is answered 400, not a retryable 502', async (t) => {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'cursor-harness-http-busy-')),
  );
  const result = Promise.withResolvers<RunResult>();
  const started = Promise.withResolvers<void>();
  let sends = 0;
  const harness = new CursorHarness(options, {
    cwd: directory,
    stateDirectory: path.join(directory, 'state'),
    createAgent: async () => ({
      agentId: 'busy-agent',
      close() {},
      async send(): Promise<Run> {
        sends++;
        started.resolve();
        return {
          id: 'busy-run',
          agentId: 'busy-agent',
          status: 'running',
          wait: () => result.promise,
          cancel: async () => {
            result.resolve({ id: 'busy-run', status: 'cancelled' });
          },
          async *stream() {},
          conversation: async () => [],
          supports: () => true,
          unsupportedReason: () => undefined,
          onDidChangeStatus: () => () => {},
        };
      },
    }),
  });
  const permissionModes = new PermissionModes(async () => ({ worker: {} }));
  await permissionModes.record({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-busy',
    permission_mode: 'auto',
  });
  const server = createNativeGateway({
    permissionModes,
    token: 'test-token',
    authFile: 'unused',
    cursor: harness,
  });
  t.after(async () => {
    result.resolve({ id: 'busy-run', status: 'cancelled' });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await harness.close();
    await removeTemporary(directory);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const request = (prompt: string, stream: boolean) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-multi-gateway-token': 'test-token',
        'x-claude-code-session-id': 'session-busy',
      },
      body: JSON.stringify({
        model: options[0].model,
        messages: [{ role: 'user', content: prompt }],
        stream,
      }),
    });
  const running = request('Start a long native run.', true);
  await started.promise;
  // The refusal is deterministic: a 502 would invite Claude to resend the same
  // prompt, whose history stops at the still-running turn.
  const refused = await request('Sent while the first turn is still running.', false);
  assert.equal(refused.status, 400);
  assert.match(JSON.stringify(await refused.json()), /already running for this Cursor agent/);
  assert.equal(sends, 1, 'the refused prompt must never reach the SDK');
  result.resolve({ id: 'busy-run', status: 'finished', result: 'native result' });
  const first = await running;
  assert.equal(first.status, 200);
  await first.text();
});

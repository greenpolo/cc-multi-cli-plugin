import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { registeredWorker } from './agents.ts';
import { runScenario } from './harness.ts';
import type { JsonObject, NativeInvocation, NativeReply, UpstreamRequest } from './types.ts';

function workerId(request: UpstreamRequest) {
  const id = JSON.stringify(request.body.messages).match(/agentId:\\?n?\s*([a-zA-Z0-9_-]+)/)?.[1];
  assert.ok(id, JSON.stringify(request.body.messages));
  return id;
}
async function gone(pid: number) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
      return;
    }
    await setTimeout(20);
  }
  assert.fail(`Native PID ${pid} survived cancellation`);
}

for (const provider of ['antigravity', 'grok'] as const) {
  test(`${provider}: cancel-native-run kills parent and child, then reports interruption`, async (t) => {
    const started = Promise.withResolvers<string>();
    const blocked = Promise.withResolvers<NativeReply>();
    t.after(() => blocked.resolve({ code: 1 }));
    let runs = 0;
    let id = '';
    const native = async (request: NativeInvocation) => {
      if (request.args[0] === 'models') {
        return {
          stdout: provider === 'grok' ? '* grok-e2e (default)\n' : 'e2e-model\tE2E Model\n',
        };
      }
      runs++;
      if (runs === 1) {
        started.resolve(path.dirname(request.cwd));
        return blocked.promise;
      }
      const flag = request.args.includes('--resume') ? '--resume' : '--session-id';
      const events =
        provider === 'grok'
          ? [
              { type: 'available_commands', tools: [] },
              { type: 'text', data: 'Interrupted state checked.' },
              {
                type: 'end',
                sessionId: request.args[request.args.indexOf(flag) + 1],
                stopReason: 'end_turn',
              },
            ]
          : [
              { event: 'init', conversation_id: 'agy-cancelled', init: {} },
              {
                event: 'result',
                result: {
                  conversation_id: 'agy-cancelled',
                  status: 'SUCCESS',
                  response: 'Interrupted state checked.',
                },
              },
            ];
      return { stdout: `${events.map((event) => JSON.stringify(event)).join('\n')}\n` };
    };
    const result = await runScenario(t, {
      name: 'cancel-native-run',
      enabledProviders: [provider],
      permissionMode: 'bypassPermissions',
      native: provider === 'grok' ? { grok: native } : { agy: native },
      env: {
        NODE_OPTIONS: `--import=${new URL('./fixtures/native-lifecycle/process-tree.ts', import.meta.url).href}`,
      },
      upstream: {
        anthropic: async (request, index) => {
          if (index === 0) {
            return {
              tool: {
                name: (request.body.tools as JsonObject[]).some((tool) => tool.name === 'Agent')
                  ? 'Agent'
                  : 'Task',
                id: 'toolu_spawn',
                input: {
                  ...registeredWorker(
                    request,
                    provider,
                    provider === 'grok' ? 'grok-e2e' : 'e2e-model',
                  ),
                  description: 'Cancellable native run',
                  prompt: 'Wait for interruption.',
                  run_in_background: true,
                },
              },
            };
          }
          if (index === 1) {
            await started.promise;
            id = workerId(request);
            return { tool: { name: 'TaskStop', id: 'toolu_stop', input: { task_id: id } } };
          }
          if (index === 2) {
            const pids = JSON.parse(
              await readFile(path.join(await started.promise, 'native-pids.json'), 'utf8'),
            ) as { parent: number; child: number };
            await Promise.all([gone(pids.parent), gone(pids.child)]);
            return {
              tool: {
                name: 'SendMessage',
                id: 'toolu_continue',
                input: {
                  to: id,
                  summary: 'Continue interrupted worker',
                  message: 'Report previous state without repeating actions.',
                },
              },
            };
          }
          return { text: 'Native cancellation verified.' };
        },
      },
    });
    if (!result) {
      return;
    }
    assert.equal(result.code, 0, result.upstreamErrors.join('\n') + result.stderr + result.stdout);
    assert.equal(runs, 2, result.stdout);
    assert.match(
      result.stdout,
      /previous turn was interrupted/,
      JSON.stringify(result.transcript.filter((event) => event.type === 'assistant')),
    );
    const resumed = result.nativeInvocations.filter(({ args }) => args[0] !== 'models')[1];
    assert.ok(resumed);
    assert.match(resumed.args.join(' '), /previous turn was interrupted/);
    assert.deepEqual(result.upstreamErrors, []);
  });
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { workerCompletions, workerId, workerTool } from './agents.ts';
import { runScenario } from './harness.ts';
import type { JsonObject, NativeInvocation } from './types.ts';

function grokReply(request: NativeInvocation) {
  if (request.args[0] === 'models') {
    return { stdout: '* grok-e2e (default)\n' };
  }
  const flag = request.args.includes('--resume') ? '--resume' : '--session-id';
  const sessionId = request.args[request.args.indexOf(flag) + 1];
  return {
    stdout: `${[
      { type: 'available_commands', tools: [] },
      { type: 'text', data: 'Native Grok turn complete.' },
      { type: 'end', sessionId, stopReason: 'end_turn' },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`,
  };
}

function agyReply(request: NativeInvocation) {
  if (request.args[0] === 'models') {
    return { stdout: 'e2e-model\tE2E Model\n' };
  }
  const conversation = request.args.includes('--conversation')
    ? request.args[request.args.indexOf('--conversation') + 1]
    : randomUUID();
  return {
    stdout: `${JSON.stringify({ event: 'init', conversation_id: conversation, init: {} })}\n${JSON.stringify({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: 'Native Antigravity turn complete.' } })}\n`,
  };
}

for (const provider of ['cursor', 'grok', 'antigravity'] as const) {
  for (const resume of [true, false]) {
    const todo = resume
      ? {
          todo: 'Main revokes a finished native worker after a later Claude prompt ("settings policy has not been admitted"); fixed on the refactor by 34ffc9a',
        }
      : {};
    test(
      `${provider}: ${resume ? 'worker turn and SendMessage resume' : 'worker-isolation'}`,
      todo,
      async (t) => {
        const worker = {
          grok: 'grok-e2e',
          cursor: 'cursor-e2e-model',
          antigravity: 'antigravity-e2e-model',
        }[provider];
        const native = {
          grok: { grok: grokReply },
          antigravity: { agy: agyReply },
          cursor: undefined,
        }[provider];
        const result = await runScenario(t, {
          name: `${provider}-workers`,
          enabledProviders: [provider],
          env: { MULTI_CURSOR_EXTRA_MODELS: 'e2e-model' },
          permissionMode: 'bypassPermissions',
          cursorModule:
            provider === 'cursor'
              ? fileURLToPath(new URL('./fixtures/native-lifecycle/cursor.ts', import.meta.url))
              : undefined,
          native,
          live: {
            providers: ['anthropic', provider],
            purpose: 'subagent',
            maxTurns: 4,
            maxBudgetUsd: 0.2,
            prompt: resume
              ? `Spawn one ${provider} native worker to reply ok without tools, then use SendMessage to ask that same worker to reply ok again. Report both replies. Do nothing else.`
              : `Spawn two separate ${provider} native workers. Each must reply ok without tools. Report both replies. Do nothing else.`,
          },
          upstream: {
            anthropic: (request, index) => {
              if (resume && index > 0) {
                if (JSON.stringify(request.body.messages).includes('toolu_resume')) {
                  return { text: 'Native workers complete.' };
                }
                if (workerCompletions(request, workerId(request)) === 0) {
                  return { text: 'Waiting for the native worker.' };
                }
                return {
                  tool: {
                    name: 'SendMessage',
                    id: 'toolu_resume',
                    input: {
                      to: workerId(request),
                      summary: 'Continue native worker',
                      message: 'Reply ok again, no tools.',
                    },
                  },
                };
              }
              if (index > 1) {
                return { text: 'Native workers complete.' };
              }
              return {
                tool: {
                  name: workerTool(request),
                  id: `toolu_worker_${index}`,
                  input: {
                    subagent_type: worker,
                    description: `Native worker ${index}`,
                    prompt: `Reply ok ${index}, no tools.`,
                  },
                },
              };
            },
          },
        });
        if (!result) {
          return;
        }
        assert.equal(result.code, 0, result.stderr + result.stdout);
        assert.match(result.stdout, /Native workers complete/);
        assert.deepEqual(result.upstreamErrors, []);
        if (provider === 'grok') {
          const runs = result.nativeInvocations.filter(({ args }) => args[0] !== 'models');
          assert.equal(runs.length, 2, result.stdout);
          const first = runs[0];
          const second = runs[1];
          assert.ok(first && second);
          const id = first.args[first.args.indexOf('--session-id') + 1];
          assert.ok(id);
          if (resume) {
            assert.equal(second.args[second.args.indexOf('--resume') + 1], id);
          } else {
            assert.ok(!second.args.includes('--resume'));
            assert.notEqual(second.args[second.args.indexOf('--session-id') + 1], id);
          }
          assert.ok(runs.every((run) => run.cwd === result.workspace));
        } else if (provider === 'antigravity') {
          const runs = result.nativeInvocations.filter(({ args }) => args[0] !== 'models');
          assert.equal(runs.length, 2, result.stdout);
          assert.equal(runs[1]?.args.includes('--conversation'), resume);
          assert.ok(!runs[0]?.args.includes('--conversation'));
        } else {
          const events = (await readFile(path.join(result.root, 'cursor-events.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as JsonObject);
          const sends = events.filter((event) => event.type === 'send');
          assert.equal(sends.length, 2, JSON.stringify(events));
          assert.equal(sends[0]?.agentId === sends[1]?.agentId, resume);
          for (const send of sends) {
            assert.match(JSON.stringify(send.model), /"fast","value":"false"/);
          }
        }
      },
    );
  }
}

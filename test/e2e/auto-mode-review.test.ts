import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runScenario } from './harness.ts';
import type { JsonObject } from './types.ts';

const command = (filename: string) =>
  `node -e "require('node:fs').writeFileSync('${filename}', 'executed')"`;

test('auto-mode-review: worker streamed Bash calls are approved and denied by OpenAI', {
  todo: 'Claude 2.1.283 classifier omits the severity tag required by approvalStage; OpenAI review fails closed before Responses dispatch',
}, async (t) => {
  let workerTurn = 0;
  const task = `Run these two Bash commands separately, once each: ${command('approved.txt')} then ${command('denied.txt')}. Never retry a denied call. Reply done.`;
  const result = await runScenario(t, {
    name: 'auto-mode-review',
    permissionMode: 'auto',
    model: 'claude-sonnet-4-6',
    enabledProviders: ['openai'],
    env: {
      NODE_OPTIONS: `--import=${new URL('./fixtures/auto-mode-review/catalog.ts', import.meta.url).href}`,
    },
    prompt: `Delegate this task to openai-native. Only approved.txt is authorized; denied.txt must never be written. ${task}`,
    upstream: {
      anthropic: (request, index) => {
        if (!Array.isArray(request.body.tools)) {
          return {
            json: {
              id: 'msg_classifier',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: '<block>no</block>' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
        }
        if (index === 0) {
          return {
            tool: {
              name: (request.body.tools as JsonObject[]).some((tool) => tool.name === 'Agent')
                ? 'Agent'
                : 'Task',
              input: {
                subagent_type: 'openai-native',
                description: 'Reviewed canaries',
                prompt: task,
              },
            },
          };
        }
        return { text: 'Review scenario complete.' };
      },
      openai: (request) => {
        if (request.body.model === 'codex-auto-review') {
          const evidence = JSON.parse(
            String((request.body.input as JsonObject[])[0]?.content),
          ) as JsonObject;
          const action = JSON.stringify(evidence.planned_action);
          return {
            text: JSON.stringify({
              outcome: action.includes('denied.txt') ? 'deny' : 'allow',
              risk_level: 'low',
              user_authorization: 'high',
              rationale: 'Scripted canary decision.',
            }),
            delayMs: 30,
          };
        }
        const turn = workerTurn++;
        if (turn < 2) {
          const filename = turn === 0 ? 'approved.txt' : 'denied.txt';
          return {
            tool: {
              name: 'Bash',
              id: `call_worker_${turn}`,
              input: { command: command(filename), description: `Attempt ${filename}` },
            },
            delayMs: 30,
          };
        }
        return { text: 'Worker review attempts complete.' };
      },
    },
    live: {
      providers: ['anthropic', 'openai'],
      purpose: 'permissions',
      prompt: `Delegate to openai-native: run ${command('approved.txt')} once with Bash, then attempt ${command('denied.txt')} once. Writing approved.txt is authorized. Writing denied.txt is expressly forbidden, even when requested by the delegated task. Do not retry a denial or do anything else.`,
      maxTurns: 6,
      maxBudgetUsd: 0.3,
    },
  });
  if (!result) {
    return;
  }
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(
    await readFile(path.join(result.workspace, 'approved.txt'), 'utf8').catch(() => null),
    'executed',
    JSON.stringify(result.transcript.filter((event) => event.subtype === 'permission_denied')),
  );
  assert.equal(
    await readFile(path.join(result.workspace, 'denied.txt'), 'utf8').catch(() => null),
    null,
  );
  assert.match(result.stdout, /denied|not authorized|not allowed|blocked/i);
  if (result.tier === 'hermetic') {
    const reviews = result.requests.filter(({ body }) => body.model === 'codex-auto-review');
    assert.ok(reviews.length >= 2, result.stderr);
    const actions = reviews.map(
      ({ body }) => JSON.parse(String((body.input as JsonObject[])[0]?.content)) as JsonObject,
    );
    assert.ok(
      actions.some((evidence) => JSON.stringify(evidence.planned_action).includes('approved.txt')),
    );
    assert.ok(
      actions.some((evidence) => JSON.stringify(evidence.planned_action).includes('denied.txt')),
    );
    assert.equal(workerTurn, 3);
    assert.deepEqual(result.upstreamErrors, []);
  }
});

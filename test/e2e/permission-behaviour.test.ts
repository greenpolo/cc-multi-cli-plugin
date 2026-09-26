import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { registeredWorker } from './agents.ts';
import { runScenario } from './harness.ts';
import type { JsonObject, PermissionMode, UpstreamScript } from './types.ts';

function delegate(provider: string, model: string | undefined, prompt: string): UpstreamScript {
  return (request, index) => {
    if (!Array.isArray(request.body.tools)) {
      // Claude's own classifier admits delegation. Worker actions still cross
      // the worker's independently inherited permission boundary.
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
            ...registeredWorker(request, provider, model),
            description: 'Permission canaries',
            prompt,
          },
        },
      };
    }
    return { text: 'Permission attempts complete; no edits beyond approved actions.' };
  };
}

const shellCommand = `node -e "require('node:fs').writeFileSync('shell.txt', 'shell\\n')"`;
const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
for (const permissionMode of modes) {
  for (const worker of [false, true]) {
    test(`permission behaviour: ${permissionMode}, OpenAI ${worker ? 'worker' : 'main'}`, async (t) => {
      const task = `Use Write once to create edit.txt containing exactly edited. Then use Bash once to run ${shellCommand}. Never retry a denied tool. Reply done.`;
      const openai: UpstreamScript = (_request, index) => {
        if (index === 0) {
          return {
            tool: {
              name: 'Write',
              id: 'call_edit',
              input: { file_path: 'edit.txt', content: 'edited' },
            },
          };
        }
        if (index === 1) {
          return {
            tool: {
              name: 'Bash',
              id: 'call_shell',
              input: { command: shellCommand, description: 'Write shell canary' },
            },
          };
        }
        return { text: 'Permission attempts complete.' };
      };
      const result = await runScenario(t, {
        name: `permission-behaviour-${permissionMode}-${worker}`,
        model: worker ? undefined : 'multi/openai/gpt-6-astra',
        permissionMode,
        enabledProviders: ['openai'],
        prompt: worker ? `Delegate to the default OpenAI worker using Agent: ${task}` : task,
        upstream: {
          openai,
          anthropic: delegate('openai', undefined, task),
        },
        live: {
          providers: worker ? ['anthropic', 'openai'] : ['openai'],
          purpose: permissionMode === 'plan' ? 'plan' : 'permissions',
          prompt: worker ? `Delegate to the default OpenAI worker using Agent: ${task}` : task,
          maxTurns: 6,
          maxBudgetUsd: 0.3,
        },
      });
      if (!result) {
        return;
      }
      assert.equal(result.code, 0, result.stderr + result.stdout);
      const edited = permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions';
      const shell = permissionMode === 'bypassPermissions';
      assert.equal(
        await readFile(path.join(result.workspace, 'edit.txt'), 'utf8').catch(() => null),
        edited ? 'edited' : null,
        result.stdout,
      );
      assert.equal(
        await readFile(path.join(result.workspace, 'shell.txt'), 'utf8').catch(() => null),
        shell ? 'shell\n' : null,
        result.stdout,
      );
      if (result.tier === 'hermetic') {
        // Live Claude may rightly decline to attempt or delegate a write in plan mode.
        assert.match(result.stdout, /tool_result/);
        const calls = result.requests.filter(
          ({ provider, path: url }) => provider === 'openai' && url.endsWith('/responses'),
        );
        assert.equal(calls.length, 3, result.stdout + result.stderr);
        const editResult = JSON.stringify(calls[1]?.body.input);
        const shellResult = JSON.stringify(calls[2]?.body.input);
        assert.match(
          editResult,
          edited ? /success|created/i : /denied|permission|not.*allowed|plan mode/i,
        );
        assert.match(
          shellResult,
          shell ? /function_call_output/ : /denied|permission|not.*allowed|plan mode/i,
        );
        assert.deepEqual(result.upstreamErrors, []);
      }
    });
  }
}

test('plan policy reaches the native agy worker without writes', async (t) => {
  const result = await runScenario(t, {
    name: 'plan-native-policy',
    permissionMode: 'plan',
    enabledProviders: ['antigravity'],
    native: {
      agy: ({ args }) =>
        args[0] === 'models'
          ? { stdout: 'e2e-model\tE2E Model\n' }
          : {
              stdout: `${JSON.stringify({ event: 'init', conversation_id: 'plan-native', init: {} })}\n${JSON.stringify({ event: 'result', result: { conversation_id: 'plan-native', status: 'SUCCESS', response: 'Plan only; no changes made.' } })}\n`,
            },
    },
    upstream: {
      anthropic: delegate(
        'antigravity',
        'e2e-model',
        'Plan an edit to edit.txt; do not execute any tools.',
      ),
    },
    live: {
      providers: ['anthropic', 'antigravity'],
      purpose: 'plan',
      prompt:
        'Delegate to an available Antigravity worker to plan an edit to edit.txt without writing files. Reply done.',
      maxTurns: 3,
      maxBudgetUsd: 0.2,
    },
  });
  if (!result) {
    return;
  }
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(
    await readFile(path.join(result.workspace, 'edit.txt'), 'utf8').catch(() => null),
    null,
  );
  assert.match(result.stdout, /no (changes|edits)/i);
  if (result.tier === 'hermetic') {
    const runs = result.nativeInvocations.filter(({ args }) => args[0] !== 'models');
    assert.equal(runs.length, 1, result.stdout);
    const run = runs[0];
    assert.ok(run);
    assert.equal(run.args[run.args.indexOf('--mode') + 1], 'plan');
    const denied = JSON.parse(run.env.MULTI_ANTIGRAVITY_DENY ?? 'null') as string[];
    for (const tool of ['run_command', 'write_to_file', 'replace_file_content']) {
      assert.ok(denied.includes(tool), JSON.stringify(run));
    }
    assert.deepEqual(result.upstreamErrors, []);
  }
});

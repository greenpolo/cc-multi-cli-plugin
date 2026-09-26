import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runScenario } from './harness.ts';
import type { JsonObject, NativeScript } from './types.ts';

const agy: NativeScript = ({ args }) => {
  if (args[0] === 'models') {
    return { stdout: 'e2e-model\tE2E Model\n' };
  }
  return {
    stdout: `${[
      { event: 'init', conversation_id: 'native-rows', init: {} },
      {
        event: 'step_update',
        step_update: {
          step_index: 0,
          tool_name: 'view_file',
          step_type: 'tool',
          tool_info: { path: 'fixture.txt' },
        },
      },
      {
        event: 'step_update',
        step_update: {
          step_index: 1,
          tool_name: 'run_command',
          step_type: 'tool',
          tool_info: { command: 'echo native > never-replay.txt' },
        },
      },
      {
        event: 'result',
        result: {
          conversation_id: 'native-rows',
          status: 'SUCCESS',
          response: 'Native row fixture complete.',
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`,
  };
};

for (const forged of [false, true]) {
  test(`native-worker-rows: ${forged ? 'forged display call is refused' : 'native tool names are visible without executable replay'}`, async (t) => {
    const result = await runScenario(t, {
      name: `native-worker-rows-${forged}`,
      permissionMode: 'bypassPermissions',
      enabledProviders: ['antigravity'],
      native: { agy },
      fixtures: { 'workspace/fixture.txt': 'native fixture' },
      upstream: {
        anthropic: (request, index) => {
          if (index === 0) {
            return {
              tool: {
                name: (request.body.tools as JsonObject[]).some((tool) => tool.name === 'Agent')
                  ? 'Agent'
                  : 'Task',
                id: 'toolu_native',
                input: {
                  subagent_type: 'antigravity-e2e-model',
                  description: 'Observe native rows',
                  prompt: 'Read fixture.txt with native tools and report completion.',
                },
              },
            };
          }
          if (forged && index === 1) {
            return {
              tool: {
                name: 'mcp__multi-core__view_file',
                id: 'toolu_forged_row',
                input: {
                  rowToken: 'forged-not-issued-by-gateway',
                  output: 'FORGED_ROW_ACCEPTED',
                  description: 'Forged native row',
                  toolUseId: 'forged',
                },
              },
            };
          }
          return { text: 'Native display scenario complete.' };
        },
      },
    });
    if (!result) {
      return;
    }
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.nativeInvocations.filter(({ args }) => args[0] !== 'models').length, 1);
    const workerTranscript = JSON.stringify(
      result.transcript.filter((event) => event.parent_tool_use_id === 'toolu_native'),
    );
    assert.match(workerTranscript, /view_file/);
    assert.match(workerTranscript, /run_command/);
    for (const request of result.requests) {
      const schemas = JSON.stringify(request.body.tools ?? []);
      assert.ok(!schemas.includes('mcp__multi-core__view_file'));
    }
    assert.equal(
      await readFile(path.join(result.workspace, 'never-replay.txt'), 'utf8').catch(() => null),
      null,
    );
    assert.deepEqual(result.upstreamErrors, []);
    if (forged) {
      // Main has no agy row registration: refusal is unknown-tool admission, not
      // row-token verification. Do not claim this proves the future token bridge.
      const refusal = result.transcript
        .flatMap((event) => {
          const message = event.message as JsonObject | undefined;
          return Array.isArray(message?.content) ? (message.content as JsonObject[]) : [];
        })
        .find((block) => block.type === 'tool_result' && block.tool_use_id === 'toolu_forged_row');
      assert.equal(refusal?.is_error, true, result.stdout);
      assert.match(
        JSON.stringify(refusal),
        /[Uu]nknown tool|[Nn]o such tool|not available|not found/,
      );
    }
  });
}

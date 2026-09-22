// Opt-in bounded Astra behavior check. Tool calls are inspected, never executed.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'openai-instructions-live-'));
const results: unknown[] = [];
let requests = 0;
const server = createNativeGateway({
  token: 'instructions-probe',
  authFile: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'),
  blockAnthropic: true,
  fetchImpl: async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert(++requests <= 3, 'Three-request inference budget exhausted');
    return fetch(url, init);
  },
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const endpoint = `http://127.0.0.1:${address.port}/v1/messages`;
const tools = [
  {
    name: 'Read',
    description: 'Read a file.',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Edit',
    description: 'Replace exact text in a file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'EnterPlanMode',
    description: 'Enter read-only planning mode. Recommended before nontrivial implementation.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'Agent',
    description:
      'Delegate a task. Available type: Explore. Recommended for codebase investigation.',
    input_schema: {
      type: 'object',
      properties: {
        subagent_type: { type: 'string' },
        prompt: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['subagent_type', 'prompt', 'description'],
    },
  },
];
async function probe(system: string, prompt: string) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-multi-gateway-token': 'instructions-probe' },
    body: JSON.stringify({
      model: 'multi/openai/gpt-6-astra',
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: prompt }],
      tools,
    }),
    signal: AbortSignal.timeout(90000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert(
    typeof result === 'object' &&
      result !== null &&
      'content' in result &&
      Array.isArray(result.content),
  );
  results.push(result);
  return result.content
    .filter(
      (block: unknown): block is { name: string } =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_use' &&
        'name' in block &&
        typeof block.name === 'string',
    )
    .map((block) => block.name);
}
try {
  const planned = await probe(
    'You are Claude Code. Follow the active session instructions. Working directory: /tmp/fixture.',
    'The greeting in greeting.txt has a typo. First enter Plan mode before investigating or editing anything.',
  );
  assert(planned.includes('EnterPlanMode'), JSON.stringify(results.at(-1)));
  assert(!planned.includes('Edit'));
  const plan = await probe(
    'The user has selected Plan mode. You MUST NOT edit files. Inspect and describe a proposed fix only. greeting.txt contains "Helo world".',
    'Fix the greeting typo in greeting.txt.',
  );
  assert(!plan.includes('Edit'));
  const delegated = await probe(
    'Working directory: /tmp/fixture. No additional restrictions.',
    'Explicitly delegate a read-only investigation of greeting.txt to the Explore agent. Do not edit anything.',
  );
  assert(delegated.includes('Agent'), JSON.stringify(results.at(-1)));
  assert(!delegated.includes('Edit'));
  console.log(
    `PASS: requested planning, active Plan restrictions, requested delegation (${requests} requests).`,
  );
} finally {
  server.closeAllConnections();
  server.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ requests, results }, null, 2));
  console.log(`Artifacts: ${root}/report.json`);
}

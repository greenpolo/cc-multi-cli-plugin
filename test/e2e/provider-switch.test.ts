import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { rawUpstream, sse } from './fixtures/provider-wire/raw-upstream.ts';
import { runScenario } from './harness.ts';

test('provider-switch: resume OpenAI reasoning on Claude without rewriting its prompt', async (t) => {
  const reasoning = {
    type: 'reasoning',
    id: 'rs_switch',
    encrypted_content: 'opaque-openai-state',
    summary: [{ type: 'summary_text', text: 'Private provider reasoning.' }],
  };
  const message = {
    id: 'msg_switch',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'OPENAI_FIRST_TURN', annotations: [] }],
  };
  const response = {
    id: 'resp_switch',
    status: 'in_progress',
    output: [],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
  const stream =
    sse('response.created', { response }) +
    [reasoning, message]
      .map(
        (item, output_index) =>
          sse('response.output_item.added', { item, output_index }) +
          sse('response.output_item.done', { item, output_index }),
      )
      .join('') +
    sse('response.completed', {
      response: { ...response, status: 'completed', output: [reasoning, message] },
    });
  const upstream = await rawUpstream(t, stream);
  const first = await runScenario(t, {
    name: 'provider-switch-openai',
    model: 'multi/openai/gpt-6-astra',
    enabledProviders: ['openai'],
    prompt: 'Remember SWITCH_CONTEXT. Reply once.',
    env: upstream.env,
  });
  if (!first) {
    return;
  }
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(upstream.requests.length, 1);
  assert.match(first.stdout, /thinking/);
  assert.match(first.stdout, /OPENAI_FIRST_TURN/);
  const terminal = first.transcript.find((event) => event.type === 'result');
  const session = String(terminal?.session_id);
  const projects = path.join(first.root, 'config', 'projects');
  const entries = await readdir(projects, { recursive: true });
  const transcript = entries.find((entry) => entry.endsWith(`${session}.jsonl`));
  assert.ok(transcript);
  const prompt = 'Keep  two spaces, Unicode λ, and punctuation: SWITCH_FOLLOWUP!';
  const second = await runScenario(t, {
    name: 'provider-switch-claude',
    prompt,
    enabledProviders: ['openai'],
    cliArgs: ['--resume', path.join(projects, transcript)],
    upstream: { anthropic: () => ({ text: 'CLAUDE_SECOND_TURN' }) },
  });
  assert.ok(second);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /CLAUDE_SECOND_TURN/);
  assert.equal(second.transcript.find((event) => event.type === 'result')?.session_id, session);
  const requests = second.requests.filter((request) => request.path.startsWith('/v1/messages?'));
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.match(request.raw, /OPENAI_FIRST_TURN/);
  assert.match(request.raw, /SWITCH_CONTEXT/);
  assert.ok(request.raw.includes(prompt));
  assert.ok(!request.raw.includes('opaque-openai-state'));
  assert.ok(!request.raw.includes('Private provider reasoning'));
  assert.ok(!request.raw.includes('encrypted_content'));
  assert.deepEqual(request.body.system, JSON.parse(second.gatewayRequests[0]?.raw ?? '{}').system);
  assert.deepEqual(second.upstreamErrors, []);
});

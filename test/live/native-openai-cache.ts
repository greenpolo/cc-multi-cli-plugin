// Opt-in: four expected Astra requests through unmodified Claude, using Codex login.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentCatalog } from '../../plugins/multi-core/src/gateway/agent-catalog.ts';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import type { ResponsesRequest } from '../../plugins/multi-openai/src/responses.ts';
import { readSse } from '../../plugins/multi-openai/src/responses.ts';
import { isolatedEnvironment } from './environment.ts';

interface Sample {
  turn: number;
  model: string;
  session: string;
  cacheKey: string;
  instructionsHash: string;
  toolsHash: string;
  input: number;
  cached: number;
  output: number;
}
interface ClaudeResult {
  type: string;
  is_error?: boolean;
  result?: string;
  usage: MessagesResponse['usage'];
}

if (process.argv.includes('--help')) {
  console.log(
    'Usage: node test/live/native-openai-cache.ts [--terminal-only]\nUses Codex login and Claude Code, Astra low effort, a synthetic Read fixture and two saved-session resumes. At most six upstream requests. Retains usage evidence in /tmp; no API billing estimates.',
  );
  process.exit(0);
}
const terminalOnly = process.argv.includes('--terminal-only');
const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-openai-cache-'));
console.log(`Artifacts: ${cwd}`);
const workers = {
  'openai-native': {
    model: 'multi/openai/gpt-6-astra',
    description: 'CACHE_VISIBLE_WORKER',
    prompt: 'Follow the task.',
    tools: ['Read'],
  },
  'openai-native-high': {
    model: 'multi/openai/gpt-6-astra',
    description: 'CACHE_HIDDEN_EFFORT',
    prompt: 'Follow the task.',
    tools: ['Read'],
    effort: 'high',
  },
  'openai-luna': {
    model: 'multi/openai/gpt-6-luna',
    description: 'CACHE_HIDDEN_MODEL',
    prompt: 'Follow the task.',
    tools: ['Read'],
  },
};
const catalog = new AgentCatalog(workers, ['multi/openai/gpt-6-astra']);
const session = randomUUID();
const token = randomUUID();
const samples: Sample[] = [];
const observations: Promise<void>[] = [];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const authFile = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  'auth.json',
);
await writeFile(
  path.join(cwd, 'fixture.txt'),
  Array.from(
    { length: 160 },
    (_, i) => `Record ${i}: amber birch cedar delta elm fir grove hazel iris juniper.\n`,
  ).join(''),
);

async function observe(response: Response, sample: Sample) {
  assert(response.body);
  for await (const raw of readSse(response.body)) {
    const event = raw as {
      type: string;
      response?: {
        usage: {
          input_tokens: number;
          output_tokens: number;
          input_tokens_details: { cached_tokens: number };
        };
      };
    };
    if (event.type === 'response.completed' && event.response) {
      sample.input = event.response.usage.input_tokens;
      sample.cached = event.response.usage.input_tokens_details.cached_tokens;
      sample.output = event.response.usage.output_tokens;
      console.log(JSON.stringify(sample));
    }
  }
}

// Move real completed items into terminal output to exercise recovery without deltas.
function terminalResponse(response: Response) {
  assert(response.body);
  const events = readSse(response.body);
  const items: unknown[] = [];
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (true) {
          const next = await events.next();
          if (next.done) {
            controller.close();
            return;
          }
          const raw = next.value;
          const event = raw as {
            type: string;
            output_index: number;
            item: unknown;
            response?: { output?: unknown[] };
          };
          if (event.type === 'response.output_item.done') {
            items[event.output_index] = event.item;
          }
          if (
            event.response &&
            ['response.completed', 'response.done', 'response.incomplete'].includes(event.type) &&
            !event.response.output?.length
          ) {
            event.response.output = items;
          }
          if (
            [
              'response.output_',
              'response.reasoning_',
              'response.function_call_',
              'response.content_part.',
            ].some((prefix) => event.type.startsWith(prefix))
          ) {
            continue;
          }
          controller.enqueue(Buffer.from(`data: ${JSON.stringify(raw)}\n\n`));
          return;
        }
      },
      async cancel() {
        await events.return(undefined);
      },
    }),
    { headers: response.headers },
  );
}

async function runClaude(port: number, turn: number) {
  const marker = `CACHE_${turn}`;
  const prompt =
    turn === 0
      ? `Read fixture.txt once using Read. Then reply only ${marker}.`
      : `Do not use tools. Reply only ${marker}.`;
  const child = spawn(
    'claude',
    [
      '-p',
      prompt,
      turn === 0 ? '--session-id' : '--resume',
      session,
      '--model',
      'multi/openai/gpt-6-astra',
      '--effort',
      'low',
      '--allowedTools',
      'Read',
      '--agents',
      JSON.stringify(workers),
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--output-format',
      'stream-json',
      '--verbose',
    ],
    {
      cwd,
      env: isolatedEnvironment({
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_CUSTOM_HEADERS: `x-multi-gateway-token: ${token}`,
        CLAUDE_CODE_MAX_RETRIES: '0',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 150000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    await writeFile(path.join(cwd, `claude-${turn}.jsonl`), stdout);
    await writeFile(path.join(cwd, `claude-${turn}.stderr`), stderr);
    assert.equal(code, 0, stderr);
    assert(!stderr.includes('DEP0190'), 'Deprecated shell spawning');
    const init = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'system' && event.subtype === 'init');
    assert(init && Array.isArray(init.agents), 'Native registered agent list unavailable');
    for (const name of Object.keys(workers)) {
      assert(init.agents.includes(name), `Hidden worker lost native registration: ${name}`);
    }
    const result: ClaudeResult | undefined = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'result');
    assert(result && !result.is_error, JSON.stringify(result));
    assert.equal(result.result?.trim(), marker);
    return result.usage;
  } finally {
    clearTimeout(timer);
  }
}

for (let turn = 0; turn < 3; turn++) {
  const server = createNativeGateway({
    token,
    authFile,
    blockAnthropic: true,
    agentCatalog: catalog,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert(samples.length < 6, 'Six-request inference budget exhausted');
      const body: ResponsesRequest = JSON.parse(String(init.body));
      assert.equal(body.model, 'gpt-6-astra');
      assert.equal(body.reasoning.effort, 'low');
      assert(body.prompt_cache_key);
      assert.match(body.prompt_cache_key, /^[a-f0-9]{64}$/);
      const input = JSON.stringify(body.input);
      await writeFile(
        path.join(cwd, `input-${turn}-${samples.length}.json`),
        JSON.stringify(body.input, null, 2),
      );
      assert(input.includes('CACHE_VISIBLE_WORKER'), 'Native CLI catalog was not observed');
      assert(!input.includes('CACHE_HIDDEN_EFFORT'), 'Reasoning variant leaked into context');
      assert(!input.includes('CACHE_HIDDEN_MODEL'), 'Non-picker model leaked into context');
      const sample: Sample = {
        turn,
        model: body.model,
        session: init.headers.session_id,
        cacheKey: body.prompt_cache_key,
        instructionsHash: hash(body.instructions),
        toolsHash: hash(body.tools),
        input: 0,
        cached: 0,
        output: 0,
      };
      samples.push(sample);
      const response = await fetch(url, init);
      assert.equal(response.status, 200);
      observations.push(observe(response.clone(), sample));
      return terminalOnly ? terminalResponse(response) : response;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const usage = await runClaude(address.port, turn);
    await Promise.all(observations);
    const current = samples.filter((sample) => sample.turn === turn);
    assert(current.length > 0);
    assert.equal(
      usage.cache_read_input_tokens,
      current.reduce((sum, sample) => sum + sample.cached, 0),
    );
    assert.equal(
      usage.input_tokens,
      current.reduce((sum, sample) => sum + sample.input - sample.cached, 0),
    );
    assert.equal(
      usage.output_tokens,
      current.reduce((sum, sample) => sum + sample.output, 0),
    );
  } finally {
    await writeFile(path.join(cwd, 'report.json'), JSON.stringify(samples, null, 2));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
assert.equal(new Set(samples.map((sample) => sample.session)).size, 1);
assert.equal(new Set(samples.map((sample) => sample.cacheKey)).size, 1);
assert.equal(new Set(samples.map((sample) => sample.instructionsHash)).size, 1);
assert.equal(new Set(samples.map((sample) => sample.toolsHash)).size, 1);
const cold = samples[0];
assert(cold);
for (const sample of samples.filter((sample) => sample.turn > 0)) {
  assert(sample.input > cold.input + 3000, 'Read fixture history must survive resume');
  assert(
    sample.cached / sample.input >= 0.9,
    'Expected at least 90% warm cache reuse; inspect report before repeating paid probes',
  );
}
console.log(
  'PASS: Astra cache reuse across native Read and two gateway restarts; Claude usage matches upstream. This does not measure subscription quota charges.',
);

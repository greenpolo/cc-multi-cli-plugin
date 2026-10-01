// Opt-in live contract for OpenCode Zen. Keep the default run small: one tool
// loop and one saved-session resume prove routing, history, and prompt reuse.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GatewayFetch } from '../../plugins/multi-core/src/gateway/fetch.ts';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import { readSse } from '../../plugins/multi-core/src/gateway/responses.ts';
import {
  createNativeGateway,
  type GatewayOptions,
} from '../../plugins/multi-core/src/gateway/server.ts';
import { readZenKey } from '../../plugins/multi-zen/src/auth.ts';
import { zenModel, zenPickerOptions } from '../../plugins/multi-zen/src/models.ts';
import { isolatedEnvironment } from './environment.ts';

interface UsageSample {
  stage: string;
  model: string;
  stickySession: string;
  cacheKey: string;
  instructionsHash: string;
  toolsHash: string;
  inputTypes: string[];
  input: number;
  cached: number;
  written: number;
  output: number;
  status: number;
  retryAfter: string | null;
}

interface ClaudeEvent {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  compact_metadata?: { trigger?: string; pre_tokens?: number };
  usage?: MessagesResponse['usage'];
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    }
  >;
  message?: { content?: string | Array<{ type?: string; name?: string }> };
}

interface RawUsage {
  input_tokens?: number;
  prompt_tokens?: number;
  output_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  cache_creation_input_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node test/live/native-zen.ts [--model MODEL] [--switch MODEL] [--compaction] [--cancel] [--min-cache-ratio RATIO]\nCovers Responses and Chat models in one bounded Zen session. The default is three inference requests; optional checks stay under twelve upstream requests. Set OPENCODE_API_KEY or connect OpenCode Zen first.',
  );
  process.exit(0);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const model = option('--model') ?? 'gpt-5.6-luna';
const switchedModel = option('--switch');
const compaction = args.includes('--compaction');
const cancellation = args.includes('--cancel');
const minCacheRatio = Number(option('--min-cache-ratio') ?? '0.9');
function requireApiKey(value: string | undefined): string {
  if (!value) {
    throw new Error('Set OPENCODE_API_KEY or connect OpenCode Zen before running the live check.');
  }
  return value;
}
const apiKey = requireApiKey(await readZenKey());
assert(!option('--model') || model.length > 0, '--model requires a non-empty model id');
assert(!switchedModel || switchedModel.length > 0, '--switch requires a non-empty model id');
assert(zenModel(model), `Unsupported Zen model: ${model}`);
if (switchedModel) {
  assert(zenModel(switchedModel), `Unsupported Zen model: ${switchedModel}`);
  assert.notEqual(switchedModel, model, '--switch must select a different model');
}
assert(Number.isFinite(minCacheRatio) && minCacheRatio >= 0 && minCacheRatio <= 1);

const artifacts = await mkdtemp(path.join(os.tmpdir(), 'native-zen-'));
console.log(`Artifacts: ${artifacts}`);
const cwd = artifacts;
const settingsFile = path.join(artifacts, 'claude-settings.json');
const pickerModels = [
  ...new Set([model, switchedModel].filter((value): value is string => value !== undefined)),
];
await writeFile(
  settingsFile,
  JSON.stringify({
    modelPicker: {
      options: zenPickerOptions(pickerModels.join(',')).map(
        ({ model: pickerModel, label, efforts }) => ({
          model: pickerModel,
          label: `Zen · ${label}`,
          behavesAs: efforts?.length ? 'claude-sonnet-4-6' : 'claude-haiku-4-5',
          description: `Zen API billing · Claude tools${efforts ? '' : ' · native reasoning; /effort not applicable'}`,
        }),
      ),
    },
  }),
);
const fixtureNonce = randomBytes(8).toString('hex');
const finalLine = `ZEN_FINAL_${fixtureNonce}`;
await writeFile(
  path.join(artifacts, 'fixture.txt'),
  Array.from({ length: 240 }, (_, index) =>
    index === 239
      ? `${finalLine}\n`
      : `Record ${index}: amber birch cedar delta elm fir grove hazel iris juniper.\n`,
  ).join(''),
);
const sessionId = randomUUID();
const gatewayToken = randomBytes(32).toString('hex');
const samples: UsageSample[] = [];
const observations: Promise<void>[] = [];
let currentStage = 'seed';
let cancellationSignal: AbortSignal | undefined;
const maxUpstreamRequests = 12;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inputTypes(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.input)) {
    return body.input.flatMap((item) =>
      record(item) && typeof item.type === 'string' ? [item.type] : [],
    );
  }
  if (!Array.isArray(body.messages)) {
    return [];
  }
  return body.messages.flatMap((message) => {
    if (!record(message)) {
      return [];
    }
    const types: string[] = [];
    if (message.role === 'tool') {
      types.push('function_call_output');
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      types.push('function_call');
    }
    return types;
  });
}

function instructions(body: Record<string, unknown>): unknown {
  if (body.instructions !== undefined) {
    return body.instructions;
  }
  if (!Array.isArray(body.messages)) {
    return undefined;
  }
  return body.messages.find((message) => record(message) && message.role === 'system');
}

async function observe(response: Response, sample: UsageSample) {
  assert(response.body, 'Zen returned no response body');
  for await (const raw of readSse(response.body)) {
    const event = raw as {
      type?: string;
      response?: { usage?: RawUsage };
      usage?: RawUsage;
    };
    const usage = event.response?.usage ?? event.usage;
    if (!usage) {
      continue;
    }
    const details = usage.input_tokens_details ?? usage.prompt_tokens_details;
    sample.input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    sample.cached = details?.cached_tokens ?? usage.cached_tokens ?? 0;
    sample.written =
      details?.cache_write_tokens ??
      details?.cache_creation_input_tokens ??
      usage.cache_write_tokens ??
      usage.cache_creation_input_tokens ??
      0;
    sample.output = usage.output_tokens ?? usage.completion_tokens ?? 0;
    console.log(JSON.stringify(sample));
  }
}

function createGateway() {
  const fetchImpl: GatewayFetch = async (url, init) => {
    if (currentStage === 'cancel') {
      cancellationSignal = init.signal;
    }
    assert(samples.length < maxUpstreamRequests, `Exceeded ${maxUpstreamRequests}-request budget`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const headers = init.headers;
    assert(headers['x-opencode-session'], 'Zen request is missing its sticky session header');
    const promptCacheKey = typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : '';
    if (body.input !== undefined) {
      assert(promptCacheKey, 'Zen Responses request is missing its prompt cache key');
      assert.equal(promptCacheKey, headers['x-opencode-session']);
    }
    const sample: UsageSample = {
      stage: currentStage,
      model: typeof body.model === 'string' ? body.model : '',
      stickySession: headers['x-opencode-session'] ?? '',
      cacheKey: promptCacheKey || headers['x-opencode-session'] || '',
      instructionsHash: hash(instructions(body)),
      toolsHash: hash(body.tools),
      inputTypes: inputTypes(body),
      input: 0,
      cached: 0,
      written: 0,
      output: 0,
      status: 0,
      retryAfter: null,
    };
    samples.push(sample);
    assert.equal(new URL(url).origin, 'https://opencode.ai');
    const response = await fetch(url, init);
    sample.status = response.status;
    sample.retryAfter = response.headers.get('retry-after');
    if (!response.ok) {
      return response;
    }
    observations.push(observe(response.clone(), sample));
    return response;
  };
  const options: GatewayOptions = {
    token: gatewayToken,
    authFile: path.join(artifacts, 'unused-codex-auth.json'),
    blockAnthropic: true,
    zen: { apiKey },
    fetchImpl,
  };
  return createNativeGateway(options);
}

async function listen() {
  const server = createGateway();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Gateway did not bind');
  return { server, port: address.port };
}

async function runClaude(
  stage: string,
  prompt: string,
  selectedModel = model,
  useTools = true,
  expectedText = finalLine,
) {
  currentStage = stage;
  const observationStart = observations.length;
  const { server, port } = await listen();
  const first = samples.length === 0;
  const outputFile = path.join(artifacts, `${stage}.jsonl`);
  const child = spawn(
    'claude',
    [
      '-p',
      prompt,
      first ? '--session-id' : '--resume',
      sessionId,
      '--model',
      `multi/zen/${selectedModel}`,
      ...(zenModel(selectedModel)?.protocol === 'responses' ? ['--effort', 'low'] : []),
      ...(useTools ? ['--tools', 'Read', '--allowedTools', 'Read'] : ['--tools', '']),
      '--strict-mcp-config',
      '--settings',
      settingsFile,
      '--setting-sources',
      '',
      ...(stage === 'compaction' ? [] : ['--disable-slash-commands']),
      '--output-format',
      'stream-json',
      '--verbose',
    ],
    {
      cwd,
      env: isolatedEnvironment({
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_CUSTOM_HEADERS: `x-multi-gateway-token: ${gatewayToken}`,
        CLAUDE_CODE_MAX_RETRIES: '0',
        CLAUDE_CODE_MAX_TURNS: '8',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let diagnostics = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    diagnostics += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    await writeFile(outputFile, output);
    await writeFile(path.join(artifacts, `${stage}.stderr`), diagnostics);
    assert.equal(code, 0, diagnostics.slice(-2000));
    const events: ClaudeEvent[] = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const result = events.findLast((event) => event.type === 'result');
    assert(result && !result.is_error, `${stage}: ${result?.result ?? 'no result'}`);
    assert.equal(result.session_id, sessionId, `${stage}: session did not resume`);
    if (expectedText) {
      assert(result.result?.includes(expectedText), `${stage}: lost expected fixture history`);
    }
    const toolUses = events.flatMap((event) =>
      event.type === 'assistant'
        ? (Array.isArray(event.message?.content) ? event.message.content : [])
            .filter((block) => block.type === 'tool_use')
            .map((block) => block.name ?? '')
        : [],
    );
    if (stage === 'seed') {
      assert.deepEqual(toolUses, ['Read'], `${stage}: expected exactly one Read call`);
    } else {
      assert.deepEqual(toolUses, [], `${stage}: unexpected tool call ${toolUses.join(', ')}`);
    }
    await Promise.all(observations.slice(observationStart));
    // Claude's turn usage excludes auxiliary title generation. Its model totals
    // include those billed requests, as do the raw upstream samples below.
    const usage = result.modelUsage?.[`multi/zen/${selectedModel}`];
    assert(usage, `${stage}: missing model usage`);
    assert.equal(usage.cacheReadInputTokens, sum(stage, 'cached'));
    assert.equal(usage.cacheCreationInputTokens, sum(stage, 'written'));
    assert.equal(usage.inputTokens, freshInput(stage));
    assert.equal(usage.outputTokens, sum(stage, 'output'));
    return { events, result };
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function sum(stage: string, field: 'cached' | 'written' | 'output') {
  return samples
    .filter((sample) => sample.stage === stage)
    .reduce((total, sample) => total + sample[field], 0);
}

function freshInput(stage: string) {
  return samples
    .filter((sample) => sample.stage === stage)
    .reduce((total, sample) => total + sample.input - sample.cached - sample.written, 0);
}

function cacheRatio(stage: string) {
  const input = samples
    .filter((sample) => sample.stage === stage)
    .reduce((total, sample) => total + sample.input, 0);
  const cached = sum(stage, 'cached');
  return { input, cached, ratio: cached / Math.max(1, input) };
}

async function cancelRequest(port: number) {
  currentStage = 'cancel';
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'content-type': 'application/json', 'x-multi-gateway-token': gatewayToken },
    body: JSON.stringify({
      model: `multi/zen/${model}`,
      stream: true,
      system: 'Answer with a very long numbered list.',
      messages: [{ role: 'user', content: 'Generate 10000 numbered lines before stopping.' }],
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await assert.rejects(request);
  const deadline = Date.now() + 5000;
  while (!cancellationSignal?.aborted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(cancellationSignal?.aborted, 'Gateway did not propagate client cancellation to Zen');
}

const { server: cancelServer, port: cancelPort } = cancellation ? await listen() : {};
try {
  await runClaude(
    'seed',
    'Read fixture.txt exactly once with Read. Remember its full contents and the nonce in the final line. Reply with the final line only.',
  );
  await runClaude('resume', 'Without using tools, repeat the exact final line from fixture.txt.');
  if (switchedModel) {
    await runClaude(
      'switch',
      'Without tools, report the exact final line from fixture.txt and say SWITCHED.',
      switchedModel,
      true,
    );
    await runClaude(
      'switch-back',
      'Without tools, report the exact final line from fixture.txt and say SWITCHED BACK.',
      model,
      true,
    );
  }
  if (compaction) {
    const compact = await runClaude(
      'compaction',
      '/compact Preserve the exact fixture nonce and final line for later turns.',
      switchedModel ?? model,
      false,
      '',
    );
    assert(
      compact.events.some(
        (event) => event.type === 'system' && event.subtype === 'compact_boundary',
      ),
      'Manual /compact produced no compact_boundary event',
    );
    await runClaude(
      'post-compaction-cold',
      'Without tools, repeat the exact final line from fixture.txt after compaction.',
      switchedModel ?? model,
      true,
    );
    await runClaude(
      'post-compaction-warm',
      'Without tools, repeat the exact final line from fixture.txt after compaction.',
      switchedModel ?? model,
      true,
    );
  }
  if (cancellation && cancelServer && cancelPort) {
    await cancelRequest(cancelPort);
  }
  await Promise.all(observations);
  const stableSamples = samples.filter(
    // Every conversation request in this fixture advertises Read. Claude's
    // auxiliary title request has its own system prompt and no tools; include
    // its spend above, but do not compare its prefix to the coding conversation.
    (sample) =>
      sample.stage !== 'cancel' && sample.stage !== 'compaction' && sample.toolsHash !== hash([]),
  );
  const sameModel = stableSamples.filter((sample) => sample.model === model);
  assert(sameModel.length >= 2, 'Expected at least two requests for the cache comparison');
  const warm = cacheRatio('resume');
  assert(
    warm.input > 0 && warm.ratio >= minCacheRatio,
    `Zen resume cache ratio ${warm.ratio.toFixed(3)} is below ${minCacheRatio}; inspect the report before repeating paid probes`,
  );
  if (compaction) {
    const postCompaction = cacheRatio('post-compaction-warm');
    assert(
      postCompaction.input > 0 && postCompaction.ratio >= minCacheRatio,
      `Zen post-compaction cache ratio ${postCompaction.ratio.toFixed(3)} is below ${minCacheRatio}; inspect the report before repeating paid probes`,
    );
  }
  assert(
    stableSamples.some(
      (sample) =>
        sample.inputTypes.includes('function_call') &&
        sample.inputTypes.includes('function_call_output'),
    ),
    'Zen tool loop did not preserve a function call and its result in history',
  );
  for (const selected of new Set(stableSamples.map((sample) => sample.model))) {
    const requests = stableSamples.filter((sample) => sample.model === selected);
    assert.equal(new Set(requests.map((sample) => sample.stickySession)).size, 1);
    assert.equal(new Set(requests.map((sample) => sample.cacheKey)).size, 1);
    assert.equal(new Set(requests.map((sample) => sample.instructionsHash)).size, 1);
    assert.equal(new Set(requests.map((sample) => sample.toolsHash)).size, 1);
  }
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(samples, null, 2));
  console.log(
    `PASS: Zen ${model} tool loop, saved resume, and prompt-cache usage; artifacts: ${artifacts}`,
  );
} catch (error) {
  await writeFile(
    path.join(artifacts, 'report.json'),
    JSON.stringify(
      { error: error instanceof Error ? error.message : String(error), samples },
      null,
      2,
    ),
  );
  throw error;
} finally {
  cancelServer?.closeAllConnections();
  if (cancelServer) {
    await new Promise<void>((resolve) => cancelServer.close(() => resolve()));
  }
}

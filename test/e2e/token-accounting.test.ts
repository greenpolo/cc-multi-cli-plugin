import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { registeredWorker, workerTool } from './agents.ts';
import { runScenario } from './harness.ts';
import { launch, sessionRoot } from './session.ts';
import type {
  JsonObject,
  NativeInvocation,
  NativeScript,
  ReplyUsage,
  UpstreamRequest,
} from './types.ts';

// Claude's context gauge, cost line, and auto-compaction all read the usage each
// route reports, so every translation is checked against distinct scripted counts.
const usage = { input: 1234, output: 56, cacheRead: 9000, cacheWrite: 300 } satisfies ReplyUsage;

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
}

function finalResult(events: JsonObject[]) {
  const result = events.findLast((event) => event.type === 'result');
  assert.ok(result, JSON.stringify(events.slice(-5)));
  return result;
}

function modelUsage(result: JsonObject, provider: string) {
  const entries = Object.entries((result.modelUsage ?? {}) as Record<string, ModelUsage>);
  const entry = entries.find(([model]) => model.includes(`multi/${provider}/`));
  assert.ok(entry, JSON.stringify(result.modelUsage));
  return entry[1];
}

for (const [provider, model] of [
  ['anthropic', 'claude-sonnet-4-6'],
  ['openai', 'multi/openai/gpt-6-astra'],
  ['zen', 'multi/zen/kimi-k3'],
  ['zen', 'multi/zen/gpt-6-luna'],
] as const) {
  test(`token-accounting: ${model} reports provider usage to Claude`, async (t) => {
    const result = await runScenario(t, {
      name: 'token-accounting-main',
      model,
      enabledProviders: provider === 'anthropic' ? [] : [provider],
      upstream: { [provider]: () => ({ text: 'Metered turn.', usage }) },
    });
    if (!result) {
      return;
    }
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const final = finalResult(result.transcript);
    assert.deepEqual(
      {
        input: (final.usage as JsonObject).input_tokens,
        output: (final.usage as JsonObject).output_tokens,
        cacheRead: (final.usage as JsonObject).cache_read_input_tokens,
        cacheWrite: (final.usage as JsonObject).cache_creation_input_tokens,
      },
      usage,
    );
    const entry = (final.modelUsage as Record<string, ModelUsage>)[model];
    assert.ok(entry, JSON.stringify(final.modelUsage));
    assert.equal(entry.contextWindow, 200000);
    t.diagnostic(`${model}: ${JSON.stringify(entry)}`);
    assert.deepEqual(result.upstreamErrors, []);
  });
}

function grok(reported: boolean): NativeScript {
  return (request: NativeInvocation) => {
    if (request.args[0] === 'models') {
      return { stdout: '* grok-e2e (default)\n' };
    }
    const end = {
      type: 'end',
      sessionId: request.args[request.args.indexOf('--session-id') + 1],
      stopReason: 'end_turn',
      ...(reported
        ? {
            usage: {
              input_tokens: usage.input,
              output_tokens: usage.output,
              cache_read_input_tokens: usage.cacheRead,
              cache_creation_input_tokens: usage.cacheWrite,
            },
          }
        : {}),
    };
    return {
      stdout: `${[
        { type: 'available_commands', tools: [] },
        { type: 'text', data: 'Metered.' },
        end,
      ]
        .map((event) => JSON.stringify(event))
        .join('\n')}\n`,
    };
  };
}

function agy(reported: boolean): NativeScript {
  return (request: NativeInvocation) => {
    if (request.args[0] === 'models') {
      return { stdout: 'gemini-e2e\tGemini E2E\n' };
    }
    const result = {
      conversation_id: 'metered',
      status: 'SUCCESS',
      response: 'Metered.',
      ...(reported
        ? {
            usage: {
              input_tokens: usage.input,
              output_tokens: usage.output,
              cache_read_tokens: usage.cacheRead,
            },
          }
        : {}),
    };
    return {
      stdout: `${JSON.stringify({ event: 'init', conversation_id: 'metered', init: {} })}\n${JSON.stringify({ event: 'result', result })}\n`,
    };
  };
}

for (const provider of ['cursor', 'grok', 'antigravity'] as const) {
  for (const reported of [true, false]) {
    test(`token-accounting: ${provider} worker ${reported ? 'reports native usage' : 'falls back to an estimate'}`, async (t) => {
      const model = { cursor: 'e2e-model', grok: 'grok-e2e', antigravity: 'gemini-e2e' }[provider];
      const result = await runScenario(t, {
        name: 'token-accounting-native',
        enabledProviders: [provider],
        env: { MULTI_CURSOR_EXTRA_MODELS: 'e2e-model' },
        permissionMode: 'bypassPermissions',
        cursorModule:
          provider === 'cursor'
            ? fileURLToPath(new URL('./fixtures/native-lifecycle/cursor.ts', import.meta.url))
            : undefined,
        fixtures:
          provider === 'cursor' && reported
            ? {
                'cursor-usage.json': JSON.stringify({
                  inputTokens: usage.input,
                  outputTokens: usage.output,
                  cacheReadTokens: usage.cacheRead,
                  cacheWriteTokens: usage.cacheWrite,
                  totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
                }),
              }
            : undefined,
        native: {
          grok: { grok: grok(reported) },
          antigravity: { agy: agy(reported) },
          cursor: undefined,
        }[provider],
        upstream: {
          anthropic: (request, index) =>
            index === 0
              ? {
                  tool: {
                    name: workerTool(request),
                    input: {
                      ...registeredWorker(request, provider, model),
                      description: 'Metered worker',
                      prompt: 'Reply ok, no tools.',
                    },
                  },
                }
              : { text: 'Metering complete.' },
        },
      });
      if (!result) {
        return;
      }
      assert.equal(result.code, 0, result.stderr + result.stdout);
      const entry = modelUsage(finalResult(result.transcript), provider);
      t.diagnostic(`${provider}: ${JSON.stringify(entry)}`);
      // Gemini rows carry the [1m] tag; every other native row keeps Claude's default window.
      assert.equal(entry.contextWindow, provider === 'antigravity' ? 1_000_000 : 200_000);
      if (reported) {
        assert.equal(entry.inputTokens, usage.input);
        assert.equal(entry.outputTokens, usage.output);
        assert.equal(entry.cacheReadInputTokens, usage.cacheRead);
        // agy reports no cache-write count.
        assert.equal(
          entry.cacheCreationInputTokens,
          provider === 'antigravity' ? 0 : usage.cacheWrite,
        );
      } else {
        assert.ok(entry.inputTokens > 0 && entry.outputTokens > 0, JSON.stringify(entry));
        assert.notEqual(entry.inputTokens, usage.input);
      }
      assert.deepEqual(result.upstreamErrors, []);
    });
  }
}

function inference(requests: UpstreamRequest[]) {
  return requests.filter((request) => request.path.endsWith('/responses'));
}

test('token-accounting: /context gauge follows reported usage; count_tokens stays local', async (t) => {
  const session = await sessionRoot(t, {
    name: 'token-accounting-gauge',
    model: 'multi/openai/gpt-6-astra',
    enabledProviders: ['openai'],
    upstream: {
      openai: () => ({ text: 'Large turn.', usage: { input: 120000, output: 50 } }),
    },
  });
  if (!session) {
    return;
  }
  let turns = 0;
  const child = launch(t, session, () => (++turns === 1 ? '/context' : undefined));
  child.send('First turn.');
  const result = await child.done;
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const report = String(finalResult(result.events).result);
  const gauge = report.match(/\*\*Tokens:\*\* ([\d.]+k) \/ (\d+k)/);
  assert.ok(gauge, report);
  t.diagnostic(`gauge ${gauge[1]} / ${gauge[2]}`);
  assert.equal(gauge[1], '120k');
  assert.equal(gauge[2], '200k');
  // The gateway answers non-Claude count_tokens itself with a local estimate.
  assert.ok(!session.upstream.requests.some((request) => request.path.includes('count_tokens')));
  assert.equal(inference(session.upstream.requests).length, 1);
  assert.deepEqual(session.upstream.errors, []);
});

test('token-accounting: reported usage near the window triggers auto-compaction', async (t) => {
  const session = await sessionRoot(t, {
    name: 'token-accounting-autocompact',
    model: 'multi/openai/gpt-6-astra',
    enabledProviders: ['openai'],
    upstream: {
      openai: (_request, index) => ({
        text: index === 1 ? 'Summary of the earlier turn.' : `Turn ${index}.`,
        usage: { input: index === 0 ? 190000 : 5000, output: 50 },
      }),
    },
  });
  if (!session) {
    return;
  }
  let turns = 0;
  const child = launch(t, session, () => (++turns === 1 ? 'Reply again.' : undefined));
  child.send('First turn.');
  const result = await child.done;
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const boundary = result.events.find(
    (event) => event.type === 'system' && event.subtype === 'compact_boundary',
  );
  assert.ok(boundary, JSON.stringify(result.events.filter((event) => event.type === 'system')));
  const metadata = boundary.compact_metadata as JsonObject;
  t.diagnostic(`compact ${JSON.stringify(metadata)}`);
  assert.equal(metadata.trigger, 'auto');
  assert.ok(Number(metadata.pre_tokens) >= 190000);
  // First turn, the compaction summary, then the second turn on the compacted history.
  const requests = inference(session.upstream.requests);
  assert.equal(requests.length, 3);
  assert.doesNotMatch(JSON.stringify(requests[2]?.body.input), /First turn\.[\s\S]*Turn 0\./);
  assert.deepEqual(session.upstream.errors, []);
});

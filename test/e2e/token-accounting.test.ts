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

// Gateway route logs say whether the usage they carry came from the provider or an estimate.
function usageSources(stderr: string, route: string) {
  return stderr
    .split('\n')
    .flatMap((line) => {
      const json = line.slice(line.indexOf('{'));
      try {
        return [JSON.parse(json) as JsonObject];
      } catch {
        return [];
      }
    })
    .filter((event) => event.route === route && event.usageMetadata)
    .map((event) => (event.usageMetadata as JsonObject).source);
}

function assertLiveNativeUsage(entry: ModelUsage, stderr: string, provider: string) {
  assert.ok(entry.inputTokens + entry.cacheReadInputTokens > 1000, JSON.stringify(entry));
  assert.ok(entry.outputTokens > 0, JSON.stringify(entry));
  const sources = usageSources(stderr, provider);
  assert.ok(sources.length > 0, stderr);
  assert.ok(
    sources.every((source) => source === 'provider'),
    sources.join(),
  );
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
        ...(reported
          ? {
              live: {
                providers: ['anthropic', provider],
                purpose: 'subagent',
                prompt: `Spawn one ${provider} native worker to reply ok without tools. Report its reply. Do nothing else.`,
                maxTurns: 3,
                maxBudgetUsd: 0.15,
              },
            }
          : {}),
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
      if (result.tier === 'live') {
        assertLiveNativeUsage(entry, result.stderr, provider);
        return;
      }
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
  return requests.filter(
    (request) => request.path.endsWith('/responses') || request.path.endsWith('/completions'),
  );
}

function thousands(value: string) {
  const scale = { k: 1000, m: 1_000_000 }[value.slice(-1).toLowerCase()] ?? 1;
  return Number(value.replace(/[km]$/i, '')) * scale;
}

function readGauge(report: string) {
  const gauge = report.match(/\*\*Tokens:\*\* ([\d.]+[km]?) \/ ([\d.]+[km])/i);
  assert.ok(gauge?.[1] && gauge[2], report);
  const categories = report.split('### Estimated usage by category')[1]?.split('###')[0] ?? '';
  const estimate = [...categories.matchAll(/^\| ([^|]+?) \| ([\d.]+k?) \|/gm)]
    .filter(([, name]) => name !== 'Free space' && name !== 'Autocompact buffer')
    .reduce((sum, [, , tokens]) => sum + thousands(tokens ?? '0'), 0);
  assert.ok(estimate > 0, report);
  return { report, total: thousands(gauge[1]), window: thousands(gauge[2]), estimate };
}

for (const [provider, model] of [
  ['anthropic', 'claude-sonnet-4-6'],
  ['openai', 'multi/openai/gpt-6-astra'],
  ['zen', 'multi/zen/kimi-k3'],
] as const) {
  test(`token-accounting: ${provider} usage feeds the /context gauge`, async (t) => {
    const session = await sessionRoot(t, {
      name: 'token-accounting-gauge',
      model,
      enabledProviders: provider === 'anthropic' ? [] : [provider],
      live: {
        providers: [provider],
        purpose: 'main-session',
        prompt: 'Reply exactly ok. Do not use tools.',
        maxTurns: 2,
        maxBudgetUsd: 0.15,
      },
      upstream: {
        [provider]: () => ({ text: 'ok', usage: { input: 120000, output: 50 } }),
      },
    });
    if (!session) {
      return;
    }
    let turns = 0;
    const child = launch(t, session, () => (++turns === 1 ? '/context' : undefined));
    child.send('Reply exactly ok. Do not use tools.');
    const result = await child.done;
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const [turn, context] = result.events.filter((event) => event.type === 'result');
    assert.ok(turn && context, result.stdout);
    const entry = (turn.modelUsage as Record<string, ModelUsage>)[model];
    assert.ok(entry, JSON.stringify(turn.modelUsage));
    const reported =
      entry.inputTokens + entry.cacheReadInputTokens + entry.cacheCreationInputTokens;
    const gauge = readGauge(String(context.result));
    const fromUsage = reported + entry.outputTokens;
    t.diagnostic(
      `${provider}: reported ${fromUsage}, estimated ${gauge.estimate} (${(gauge.estimate / fromUsage).toFixed(2)}x), gauge ${gauge.total} / ${gauge.window}`,
    );
    assert.equal(gauge.window, entry.contextWindow);
    // Claude shows the larger of reported usage and its per-category estimate, which
    // for non-Claude routes comes from the gateway's local count_tokens. Each figure
    // is printed to one decimal place of thousands.
    assert.ok(Math.abs(gauge.total - Math.max(fromUsage, gauge.estimate)) <= 400, gauge.report);
    if (session.live) {
      // Claude Code's own system prompt and tool schemas alone exceed this.
      assert.ok(reported > 5000, JSON.stringify(entry));
      if (provider !== 'anthropic') {
        const sources = usageSources(result.stderr, provider);
        assert.ok(sources.length > 0, result.stderr);
        assert.ok(
          sources.every((source) => source === 'provider'),
          sources.join(),
        );
      }
      return;
    }
    assert.equal(reported, 120000);
    assert.deepEqual(session.upstream.errors, []);
    if (provider !== 'anthropic') {
      // The gateway answers non-Claude count_tokens itself with a local estimate.
      assert.ok(
        !session.upstream.requests.some((request) => request.path.includes('count_tokens')),
      );
      assert.equal(inference(session.upstream.requests).length, 1);
    }
  });
}

// Behind the gateway's base URL, Claude offers Opus 1M only on request.
test('token-accounting: default Opus keeps its native 1M window', {
  todo: 'Claude grants the native 1M default only to a first-party base URL; _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL also turns on the server-side auto-mode classifier, which translated routes cannot carry',
}, async (t) => {
  const session = await sessionRoot(t, {
    name: 'token-accounting-opus-window',
    model: 'opus',
    enabledProviders: [],
    live: {
      providers: ['anthropic'],
      purpose: 'main-session',
      prompt: '/context',
      maxTurns: 1,
      maxBudgetUsd: 0.05,
    },
  });
  if (!session) {
    return;
  }
  const child = launch(t, session);
  child.send('/context');
  const result = await child.done;
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const gauge = readGauge(String(finalResult(result.events).result));
  assert.equal(gauge.window, 1_000_000, gauge.report);
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

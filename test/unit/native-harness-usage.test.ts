import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  AntigravityResult,
  AntigravityRunOptions,
  AntigravityStreamEvent,
  AntigravityUsage,
} from '../../plugins/multi-antigravity/src/cli.ts';
import { AntigravityHarness } from '../../plugins/multi-antigravity/src/harness.ts';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { ReceiptLedger } from '../../plugins/multi-core/src/gateway/receipts.ts';
import type { GrokRunOptions, GrokUsage } from '../../plugins/multi-grok/src/cli.ts';
import { GrokHarness } from '../../plugins/multi-grok/src/harness.ts';
import { grokPermissionPolicy } from '../../plugins/multi-grok/src/permissions.ts';
import { removeTemporary } from '../temporary.ts';

const context: PermissionContext = { permissionMode: 'auto', cwd: process.cwd() };
const agyModel = {
  id: 'gemini-test-low',
  model: 'multi/antigravity/gemini-test-low',
  label: 'Test',
};
const fixtures = path.join(import.meta.dirname, 'fixtures');

function lines(file: string): Record<string, unknown>[] {
  return readFileSync(path.join(fixtures, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A captured agy run: its stream events and its terminal result. */
function agyCapture(name: string) {
  const events = lines(`antigravity/${name}`) as AntigravityStreamEvent[];
  const terminal = events.find((event) => event.event === 'result');
  assert.ok(terminal?.event === 'result');
  return { events: events.filter((event) => event.event !== 'result'), result: terminal.result };
}

async function agyHarness(
  t: test.TestContext,
  runs: Array<{ events: AntigravityStreamEvent[]; result: AntigravityResult }>,
) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-calls-'));
  t.after(() => removeTemporary(stateDirectory));
  let index = 0;
  const harness = new AntigravityHarness([agyModel], {
    stateDirectory,
    checkPermissions: async () => ({ denied: [], plan: false, notice: 'Native policy' }),
    run: async (options: AntigravityRunOptions) => {
      const run = runs[index++];
      assert.ok(run, 'unexpected native run');
      for (const event of run.events) {
        options.onEvent?.(event);
      }
      return { result: run.result, exitCode: 0, signal: null, stderr: '' };
    },
  });
  t.after(() => harness.close());
  return harness;
}

function askAgy(harness: AntigravityHarness, content: string) {
  return harness.handle(
    { model: agyModel.model, messages: [{ role: 'user', content }] },
    'calls',
    new AbortController().signal,
    undefined,
    context,
  );
}

function text(response: MessagesResponse) {
  return response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

test('an uncached Gemini agy turn reports its last call as context and its sums as consumption', async (t) => {
  const harness = await agyHarness(t, [agyCapture('calls-gemini.jsonl')]);
  const response = await askAgy(harness, 'run the probe');
  // The last `agent_response` step (index 9), not the result's 62,645-token sum.
  assert.deepEqual(response.usage, {
    input_tokens: 12964,
    output_tokens: 2,
    cache_read_input_tokens: 0,
  });
  assert.deepEqual(response.multi_usage, {
    source: 'provider',
    model: 'gemini-test-low',
    effort: 'low',
    consumed_input_tokens: 62645,
    consumed_output_tokens: 454,
    consumed_cache_read_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 63099,
    model_calls: 5,
  });
  assert.match(
    text(response),
    /\[Antigravity\] 4 native actions: 1 read, 3 shell; 5 model calls\./,
  );
});

test('a cached Claude agy turn reports the last call cache read beside its uncached input', async (t) => {
  const harness = await agyHarness(t, [agyCapture('calls-sonnet.jsonl')]);
  const response = await askAgy(harness, 'run the probe');
  assert.deepEqual(response.usage, {
    input_tokens: 1486,
    output_tokens: 5,
    cache_read_input_tokens: 13346,
  });
  assert.equal(response.multi_usage?.consumed_input_tokens, 15319);
  assert.equal(response.multi_usage?.consumed_output_tokens, 540);
  assert.equal(response.multi_usage?.consumed_cache_read_tokens, 13346);
  assert.equal(response.multi_usage?.total_tokens, 15859);
  assert.equal(response.multi_usage?.model_calls, 2);
});

test('a resumed agy turn takes the delta of the cumulative result but never of its context', async (t) => {
  const first = agyCapture('calls-gemini.jsonl');
  const previous = first.result.usage as AntigravityUsage;
  const cumulative = Object.fromEntries(
    Object.entries(previous).map(([key, value]) => [key, value * 2]),
  ) as AntigravityUsage;
  const harness = await agyHarness(t, [
    first,
    { events: first.events, result: { ...first.result, usage: cumulative } },
  ]);
  await askAgy(harness, 'run the probe');
  const second = await harness.handle(
    {
      model: agyModel.model,
      messages: [
        { role: 'user', content: 'run the probe' },
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: 'again' },
      ],
    },
    'calls',
    new AbortController().signal,
    undefined,
    context,
  );
  assert.equal(second.multi_usage?.replayed, undefined);
  assert.equal(second.usage.input_tokens, 12964);
  assert.equal(second.multi_usage?.consumed_input_tokens, 62645);
  assert.equal(second.multi_usage?.consumed_output_tokens, 454);
  assert.equal(second.multi_usage?.model_calls, 5);
});

test('an agy run without per-call usage keeps the turn usage in the standard fields', async (t) => {
  const capture = agyCapture('calls-gemini.jsonl');
  const events = capture.events.map((event) => {
    if (event.event !== 'step_update') {
      return event;
    }
    const { usage: _usage, ...update } = event.step_update;
    return { ...event, step_update: update };
  });
  const harness = await agyHarness(t, [{ events, result: capture.result }]);
  const response = await askAgy(harness, 'run the probe');
  assert.equal(response.usage.input_tokens, 62645);
  assert.equal(response.multi_usage?.consumed_input_tokens, 62645);
  assert.equal(response.multi_usage?.model_calls, undefined);
});

test('Grok reports its last usage event as context and its end event as consumption', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'grok-calls-'));
  t.after(() => removeTemporary(stateDirectory));
  const capture = lines('grok/tool-denied-by-rule.jsonl');
  const end = capture.find((line) => line.type === 'end');
  assert.ok(end);
  const harness = new GrokHarness(
    [
      {
        id: 'grok-4.6',
        model: 'multi/grok/grok-4.6',
        label: 'Grok 4.6',
        default: true,
      },
    ],
    {
      stateDirectory,
      checkPermissions: async (_cwd, value) => grokPermissionPolicy(value),
      run: async (options: GrokRunOptions) => {
        for (const line of capture) {
          if (line.type === 'usage') {
            options.onEvent?.({ event: 'usage', usage: line.usage as GrokUsage });
          }
        }
        return {
          result: {
            sessionId: options.resume ?? options.session ?? 'unknown',
            stopReason: 'end_turn',
            usage: end.usage as GrokUsage,
            turns: end.num_turns as number,
          },
          response: 'native',
          exitCode: 0,
          signal: null,
          stderr: '',
        };
      },
    },
  );
  t.after(() => harness.close());
  const response = await harness.handle(
    { model: 'multi/grok/grok-4.6', messages: [{ role: 'user', content: 'probe' }] },
    'calls',
    new AbortController().signal,
    undefined,
    context,
  );
  assert.deepEqual(response.usage, {
    input_tokens: 363,
    output_tokens: 363,
    cache_read_input_tokens: 33280,
    cache_creation_input_tokens: 0,
  });
  assert.equal(response.multi_usage?.consumed_input_tokens, 32438);
  assert.equal(response.multi_usage?.consumed_cache_read_tokens, 67712);
  assert.equal(response.multi_usage?.consumed_output_tokens, 737);
  assert.equal(response.multi_usage?.model_calls, 3);
});

test('receipts charge consumption, not the context a harness turn reports', () => {
  const ledger = new ReceiptLedger();
  ledger.observe({
    route: 'antigravity',
    session: 's',
    agentId: 'worker',
    model: 'gemini-test-low',
    usage: { input_tokens: 12964, output_tokens: 2, cache_read_input_tokens: 0 },
    usageMetadata: {
      source: 'provider',
      consumed_input_tokens: 62645,
      consumed_output_tokens: 454,
      consumed_cache_read_tokens: 0,
      total_tokens: 63099,
      model_calls: 5,
    },
  });
  ledger.observe({
    route: 'openai',
    session: 's',
    agentId: 'worker',
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900 },
    usageMetadata: { source: 'provider' },
  });
  const receipt = ledger.complete({ session: 's', agentId: 'worker' }, 'completed');
  assert.ok(receipt);
  assert.deepEqual(receipt.usage, {
    input_tokens: 62745,
    output_tokens: 464,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
    total_tokens: 63099,
    model_calls: 5,
  });
  assert.deepEqual(receipt.context, {
    input_tokens: 100,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
  });
  const session = ledger.snapshot('s');
  assert.deepEqual(session.contexts?.antigravity, {
    input_tokens: 12964,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  assert.equal(
    session.entries.find((entry) => entry.provider === 'antigravity')?.usage.input_tokens,
    62645,
  );
});

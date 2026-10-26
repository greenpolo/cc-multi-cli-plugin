import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import type {
  MessagesRequest,
  MessagesResponse,
} from '../../plugins/multi-core/src/gateway/messages.ts';
import {
  autoReviewPolicy,
  PROVIDER_AUTO_REVIEW,
} from '../../plugins/multi-core/src/gateway/provider.ts';
import { failureMessage } from '../../plugins/multi-core/src/gateway/server.ts';
import {
  dangerousToolMode,
  type Reviewer,
  verdictsFor,
} from '../../plugins/multi-core/src/gateway/verdicts.ts';

const request = (mode: unknown = 'auto'): MessagesRequest => ({
  safeguards: [{ type: 'dangerous_tool_use', classifier_context: { permission_mode: mode } }],
});
const reply = (names = ['Bash']): MessagesResponse => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'multi/openai/gpt-6-luna',
  content: names.map((name, index) => ({ type: 'tool_use', id: `call_${index}`, name, input: {} })),
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 0, output_tokens: 0 },
});
const signal = () => new AbortController().signal;
const allow: Reviewer = async () => ({ model: 'stub-reviewer', outcome: 'allow' });

test('provider table determines verdicts for every supported mode and launch discovery failure', async () => {
  for (const provider of Object.keys(PROVIDER_AUTO_REVIEW) as Array<
    keyof typeof PROVIDER_AUTO_REVIEW
  >) {
    for (const available of [true, false]) {
      const policy = autoReviewPolicy(provider, available);
      assert(policy.statement.length > 0);
      for (const mode of [
        'auto',
        'default',
        'acceptEdits',
        'dontAsk',
        'bypassPermissions',
        'plan',
        '',
        'unknown',
      ]) {
        const result = await verdictsFor(
          request(mode),
          reply(),
          policy,
          available ? allow : undefined,
          signal(),
        );
        const expected = expectedOutcome(mode, policy.review);
        assert.equal(
          result?.[0].status.tool_uses.call_0.outcome,
          expected,
          `${provider}/${available}/${mode}`,
        );
      }
    }
  }
  assert.equal(autoReviewPolicy('openai', false).review, 'none');
  assert.match(autoReviewPolicy('openai', false).statement, /unreviewed/);
});

test('read-only calls skip review, plan writes block first, all harness handbacks pass', async () => {
  let calls = 0;
  const reviewer: Reviewer = async (input) => {
    calls++;
    assert(input.planMode);
    return { model: 'stub', outcome: 'allow' };
  };
  const response = reply([
    'Read',
    'Glob',
    'Grep',
    'LS',
    'ToolSearch',
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
    'Bash',
  ]);
  const result = await verdictsFor(
    request('plan'),
    response,
    PROVIDER_AUTO_REVIEW.openai,
    reviewer,
    signal(),
  );
  assert.equal(calls, 1);
  assert.equal(result?.[0].status.tool_uses.call_0.outcome, 'not_flagged');
  assert.equal(result?.[0].status.tool_uses.call_5.outcome, 'flagged');
  for (const provider of ['cursor', 'antigravity', 'grok'] as const) {
    const handback = await verdictsFor(
      { ...request('plan'), model: `multi/${provider}/test` },
      reply(['SubagentHandback']),
      PROVIDER_AUTO_REVIEW[provider],
      undefined,
      signal(),
    );
    assert.equal(handback?.[0].status.tool_uses.call_0.outcome, 'not_flagged');
  }
});

test('a direct-provider handback still uses its account reviewer', async () => {
  let calls = 0;
  const reviewer: Reviewer = async () => {
    calls++;
    return { model: 'stub', outcome: 'deny' };
  };
  const result = await verdictsFor(
    { ...request(), model: 'multi/openai/test' },
    reply(['SubagentHandback']),
    PROVIDER_AUTO_REVIEW.openai,
    reviewer,
    signal(),
  );
  assert.equal(calls, 1);
  assert.equal(result?.[0].status.tool_uses.call_0.outcome, 'flagged');
});

test('review allow, deny, exception and aborted deadline always produce evaluated prose verdicts', async () => {
  const reviewers: Reviewer[] = [
    allow,
    async () => ({ model: 'stub', outcome: 'deny', reason: 'Denied [rule]' }),
    async () => {
      throw new Error('failure');
    },
  ];
  for (const [index, reviewer] of reviewers.entries()) {
    const results = await verdictsFor(
      request(),
      reply(),
      PROVIDER_AUTO_REVIEW.openai,
      reviewer,
      signal(),
    );
    const verdict = results?.[0].status.tool_uses.call_0;
    assert.equal(verdict?.type, 'evaluated');
    assert.equal(verdict?.outcome, index === 0 ? 'not_flagged' : 'flagged');
    if (verdict?.outcome === 'flagged') {
      assert.doesNotMatch(verdict.explanation, /[[\]]/);
    }
  }
  const abort = new AbortController();
  const pending = verdictsFor(
    request(),
    reply(),
    PROVIDER_AUTO_REVIEW.openai,
    async () => new Promise(() => {}),
    abort.signal,
  );
  abort.abort(new Error('review timed out'));
  assert.equal((await pending)?.[0].status.tool_uses.call_0.outcome, 'flagged');
});

test('per-reply review concurrency is bounded and every id, including __proto__, has a verdict', async () => {
  let active = 0;
  let peak = 0;
  const reviewer: Reviewer = async () => {
    active++;
    peak = Math.max(peak, active);
    await setTimeout(5);
    active--;
    return { model: 'stub', outcome: 'allow' };
  };
  const response = reply(Array.from({ length: 13 }, () => 'Bash'));
  const first = response.content[0];
  assert(first.type === 'tool_use');
  first.id = '__proto__';
  const result = await verdictsFor(
    request(),
    response,
    PROVIDER_AUTO_REVIEW.openai,
    reviewer,
    signal(),
  );
  assert.equal(peak, 4);
  const map = JSON.parse(JSON.stringify(result))[0].status.tool_uses;
  for (const block of response.content) {
    if (block.type === 'tool_use') {
      assert(Object.hasOwn(map, block.id));
    }
  }
  assert.equal(Object.keys(map).length, 13);
});

test('present but malformed verdict requests still get results; text-only failures get an empty map', async () => {
  for (const value of [null, {}, [], [null], [{ type: 'dangerous_tool_use' }]]) {
    const results = await verdictsFor(
      { safeguards: value },
      reply(),
      PROVIDER_AUTO_REVIEW.zen,
      undefined,
      signal(),
    );
    assert.equal(results?.[0].status.tool_uses.call_0.outcome, 'flagged');
    assert.equal(dangerousToolMode(value), '');
  }
  assert.equal(
    await verdictsFor({}, reply(), PROVIDER_AUTO_REVIEW.zen, undefined, signal()),
    undefined,
  );
  const failure = failureMessage(new Error('safeguards dangerous-tool-use BETA'), 'multi/openai/x');
  assert.doesNotMatch(JSON.stringify(failure), /safeguards|dangerous-tool-use|beta/i);
  assert.deepEqual(
    (await verdictsFor(request(), failure, PROVIDER_AUTO_REVIEW.openai, allow, signal()))?.[0]
      .status.tool_uses,
    {},
  );
});

function expectedOutcome(mode: string, review: string) {
  if (mode === '' || mode === 'unknown') {
    return 'flagged';
  }
  return mode === 'plan' && review !== 'reviewer' ? 'flagged' : 'not_flagged';
}

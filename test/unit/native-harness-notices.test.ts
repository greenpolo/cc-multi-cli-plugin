import assert from 'node:assert/strict';
import test from 'node:test';
import {
  continuation,
  harnessHistoryHash,
  historyRewound,
  interruptedNotice,
  safeText,
  stderrDiagnostics,
  terminalSuffix,
  writeNotices,
} from '../../plugins/multi-core/src/gateway/harness-notices.ts';
import { HarnessResponse } from '../../plugins/multi-core/src/gateway/harness-response.ts';
import type { Emit, MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';

function response() {
  const emit: Emit = () => {};
  return new HarnessResponse('native-1', 1, emit);
}

function text(value: HarnessResponse): string {
  const finished = value.finish(undefined);
  const block = finished.content[0];
  return block?.type === 'text' ? block.text : '';
}

const answer: MessagesResponse = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'native-1',
  content: [{ type: 'text', text: 'previous answer' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

test('a turn opens with the policy, interruption and rewind notices it needs', () => {
  const all = response();
  writeNotices(all, {
    tag: 'Native',
    interrupted: true,
    rewound: true,
    notice: 'Auto mode',
    noticeChanged: true,
  });
  assert.equal(
    text(all),
    '[Native] Auto mode\n' +
      `${interruptedNotice('Native')}\n` +
      '[Native] Outer history changed; the native conversation continues with its own record.\n',
  );

  const unchanged = response();
  writeNotices(unchanged, {
    tag: 'Native',
    interrupted: false,
    rewound: false,
    notice: 'Auto mode',
    noticeChanged: false,
  });
  assert.equal(text(unchanged), '');

  // A provider with no policy line passes none and still reports an interruption.
  const quiet = response();
  writeNotices(quiet, { tag: 'Native', interrupted: true, rewound: false, noticeChanged: true });
  assert.equal(text(quiet), `${interruptedNotice('Native')}\n`);
  assert.match(interruptedNotice('Native'), /do not repeat completed actions/);
});

test('diagnostics keep no credentials and no terminal control bytes', () => {
  assert.equal(safeText('Bearer abc123 token=zzz'), 'Bearer [redacted] token=[redacted]');
  assert.equal(safeText('one\u0000two\u001b[31m'), 'one two [31m');
  assert.equal(safeText('x'.repeat(600)).length, 500);

  const stderr = ['starting up', 'WARN slow disk', 'permission denied for /tmp', 'done'].join('\n');
  assert.equal(stderrDiagnostics(stderr), 'WARN slow disk permission denied for /tmp');
  assert.equal(stderrDiagnostics('nothing interesting\n'), '');
  assert.equal(stderrDiagnostics('api_key=secret failed'), 'api_key=[redacted] failed');
});

test('a follow-up forwards only the newest turn', () => {
  const body = {
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'previous answer' },
      { role: 'user', content: 'second' },
    ],
  };
  assert.deepEqual(continuation(body), [{ role: 'user', content: 'second' }]);
  assert.throws(
    () => continuation({ messages: body.messages.slice(0, 2) }),
    /message after the last assistant turn/,
  );
  assert.throws(
    () =>
      continuation({
        messages: [...body.messages.slice(0, 2), { role: 'system', content: 'note' }],
      }),
    /requires a new user message/,
  );
});

test('an outer history that dropped the last answer continues on the native record', () => {
  const kept = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: answer.content },
    { role: 'user', content: 'second' },
  ];
  assert.equal(historyRewound({ response: answer }, kept, harnessHistoryHash), false);
  assert.equal(
    historyRewound({ response: answer }, [{ role: 'user', content: 'second' }], harnessHistoryHash),
    true,
  );
  // A first turn has nothing to compare against.
  assert.equal(historyRewound({}, [], harnessHistoryHash), false);
});

test('moved cache markers keep one identity and reminders only when asked', () => {
  const marked = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
    },
  ];
  const plain = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
  assert.equal(harnessHistoryHash(marked), harnessHistoryHash(plain));

  const nested = [
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: 'out', cache_control: { type: 'ephemeral' } }],
        },
      ],
    },
  ];
  const nestedPlain = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'out' }] },
      ],
    },
  ];
  assert.equal(harnessHistoryHash(nested), harnessHistoryHash(nestedPlain));

  const reminded = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello<system-reminder>catalogue</system-reminder>' }],
    },
  ];
  assert.notEqual(harnessHistoryHash(reminded), harnessHistoryHash(plain));
  assert.equal(
    harnessHistoryHash(reminded, { stripReminders: true }),
    harnessHistoryHash(plain, { stripReminders: true }),
  );
  assert.equal(harnessHistoryHash(undefined), harnessHistoryHash(undefined));
});

test('a terminal answer only adds what the stream did not already deliver', () => {
  assert.equal(terminalSuffix('hello ', 'hello world'), 'world');
  assert.equal(terminalSuffix('hello world', 'world'), '');
  assert.equal(terminalSuffix('', 'whole answer'), 'whole answer');
  assert.equal(terminalSuffix('streamed', 'different'), 'different');
});

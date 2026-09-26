import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { InteractionUpdate, Run, RunResult, SendOptions } from '@cursor/sdk';
import { DisplayRows, ROW_TOKEN } from '../../plugins/multi-core/src/gateway/display-rows.ts';
import {
  NativeActionTracker,
  type NativeObservation,
} from '../../plugins/multi-core/src/gateway/harness-progress.ts';
import type { Emit, MessagesRequest } from '../../plugins/multi-core/src/gateway/messages.ts';
import { CursorHarness } from '../../plugins/multi-cursor/src/harness.ts';
import { cursorModelOptions } from '../../plugins/multi-cursor/src/models.ts';
import {
  CURSOR_TOOLS,
  cursorContextNotice,
  cursorEditMirror,
  observeCursorUpdate,
} from '../../plugins/multi-cursor/src/progress.ts';
import { removeTemporary } from '../temporary.ts';

const shell = {
  type: 'shell',
  args: { command: 'printf hello', workingDirectory: '/workspace' },
} satisfies Extract<InteractionUpdate, { type: 'tool-call-started' }>['toolCall'];

function started(
  callId: string,
  toolCall: Extract<InteractionUpdate, { type: 'tool-call-started' }>['toolCall'],
) {
  return { type: 'tool-call-started', callId, modelCallId: 'model-1', toolCall } as const;
}

function recorded() {
  const seen: NativeObservation[] = [];
  const tracker = new NativeActionTracker('Cursor', (observation) => {
    seen.push(observation);
    return undefined;
  });
  return { seen, tracker };
}

test('native tool starts carry the SDK tool name, its arguments and a one-line summary', () => {
  const { seen, tracker } = recorded();
  observeCursorUpdate(started('shell-1', shell), tracker);
  observeCursorUpdate(
    started('write-1', {
      type: 'write',
      args: { path: 'safe\r\nname‮.txt', fileText: 'content' },
    }),
    tracker,
  );
  observeCursorUpdate(
    started('shell-2', {
      type: 'shell',
      args: { command: 'printf before\u001b]0;private\u0007after\u001b[2J' },
    }),
    tracker,
  );
  observeCursorUpdate({ type: 'thinking-delta', text: 'hidden' }, tracker);
  observeCursorUpdate({ type: 'text-delta', text: 'answer' }, tracker);
  assert.deepEqual(seen, [
    {
      type: 'started',
      id: 'shell-1',
      kind: 'shell',
      tool: 'shell',
      description: 'Shell: printf hello',
    },
    {
      type: 'started',
      id: 'write-1',
      kind: 'edit',
      tool: 'write',
      description: 'write: safe name.txt',
    },
    {
      type: 'started',
      id: 'shell-2',
      kind: 'shell',
      tool: 'shell',
      description: 'Shell: printf beforeafter',
    },
  ]);
});

test('ls completions list immediate children as paths, directories with a trailing slash', () => {
  const { seen, tracker } = recorded();
  // Synthetic `LsSuccess` (`directoryTreeRoot`: `LsDirectoryTreeNode`) per
  // `@cursor/sdk` `vendor/cursor-sdk-shared/tool-call-types.d.ts`.
  type TreeNode = {
    absPath: string;
    childrenDirs: TreeNode[];
    childrenFiles: { name: string }[];
    childrenWereProcessed: boolean;
    fullSubtreeExtensionCounts: Record<string, number>;
    numFiles: number;
  };
  const emptyNode: Omit<TreeNode, 'absPath'> = {
    childrenDirs: [],
    childrenFiles: [],
    childrenWereProcessed: true,
    fullSubtreeExtensionCounts: {},
    numFiles: 0,
  };
  observeCursorUpdate(started('ls-1', { type: 'ls', args: { path: '/workspace' } }), tracker);
  observeCursorUpdate(
    {
      type: 'tool-call-completed',
      callId: 'ls-1',
      modelCallId: 'model-1',
      toolCall: {
        type: 'ls',
        args: { path: '/workspace' },
        result: {
          status: 'success',
          value: {
            directoryTreeRoot: {
              absPath: '/workspace',
              childrenDirs: [
                {
                  ...emptyNode,
                  absPath: '/workspace/src',
                  numFiles: 3,
                },
              ],
              childrenFiles: [{ name: 'README.md' }, { name: 'package.json' }],
              childrenWereProcessed: true,
              fullSubtreeExtensionCounts: { '.md': 1, '.json': 1 },
              numFiles: 5,
            },
          },
        },
      },
    },
    tracker,
  );
  const completed = seen.find((item) => item.type === 'completed' && item.id === 'ls-1');
  assert.ok(completed?.type === 'completed');
  assert.equal(
    completed.row.output,
    '/workspace/src/\n/workspace/README.md\n/workspace/package.json',
  );
});

test('completions carry the native output: stdout, stderr, exit code, errors and diffs', () => {
  const { seen, tracker } = recorded();
  observeCursorUpdate(started('shell-1', shell), tracker);
  observeCursorUpdate(
    {
      type: 'tool-call-completed',
      callId: 'shell-1',
      modelCallId: 'model-1',
      toolCall: {
        ...shell,
        result: {
          status: 'success',
          value: { exitCode: 7, signal: '', stdout: 'out', stderr: 'boom', executionTime: 12.4 },
        },
      },
    },
    tracker,
  );
  // A completion whose start was never reported still becomes one action.
  observeCursorUpdate(
    {
      type: 'tool-call-completed',
      callId: 'shell-2',
      modelCallId: 'model-1',
      toolCall: { ...shell, result: { status: 'error', error: 'Permission denied' } },
    },
    tracker,
  );
  observeCursorUpdate(
    {
      type: 'tool-call-completed',
      callId: 'edit-1',
      modelCallId: 'model-1',
      toolCall: {
        type: 'edit',
        args: { path: 'notes.txt' },
        result: { status: 'success', value: { linesAdded: 2, linesRemoved: 1, diffString: '+x' } },
      },
    },
    tracker,
  );
  const completed = seen.filter((item) => item.type === 'completed');
  assert.deepEqual(
    completed.map((item) => [item.id, item.outcome, item.error, item.row]),
    [
      [
        'shell-1',
        'exit 7 · 12 ms',
        true,
        { tool: 'shell', input: shell.args, output: 'out\nboom\nexit 7', error: true },
      ],
      [
        'shell-2',
        'denied',
        true,
        { tool: 'shell', input: shell.args, output: 'Permission denied', error: true },
      ],
      [
        'edit-1',
        '+2 -1 lines',
        false,
        { tool: 'edit', input: { path: 'notes.txt' }, output: '+x', error: false },
      ],
    ],
  );
});

type CursorToolCall = Extract<InteractionUpdate, { type: 'tool-call-started' }>['toolCall'];

/**
 * Completed `edit` calls from a real Composer 2.5 run (paths rewritten). Their
 * results are the SDK's `EditSuccess` (`linesAdded`, `linesRemoved`, `diffString`;
 * `@cursor/sdk` `vendor/cursor-sdk-shared/tool-call-types.d.ts`): a file it
 * created is a diff from `/dev/null`, since the SDK exposes no created flag.
 */
const editResults = (
  JSON.parse(
    readFileSync(new URL('fixtures/cursor/edit-results.json', import.meta.url), 'utf8'),
  ) as CursorToolCall[]
).filter((call) => call.type === 'edit');

test('an edit row takes its two sides from the diff, a created file becomes a Write', () => {
  const [changed, created] = editResults;
  assert(changed && created);
  assert.deepEqual(cursorEditMirror(changed), {
    fields: { old_string: 'one\nalpha\nthree\nfour', new_string: 'one\nbeta\nthree\nfour' },
  });
  assert.deepEqual(cursorEditMirror(created), {
    kind: 'Write',
    fields: { content: 'hello\nworld' },
  });
  const rows = new DisplayRows();
  rows.announce(['edit']);
  rows.acknowledge(['edit']);
  const issued: Array<Record<string, unknown>> = [];
  const tracker = new NativeActionTracker(
    'Cursor',
    (observation) =>
      observation.type === 'completed' ? rows.issue('["s"]', observation.row) : undefined,
    (block) => issued.push(block.input),
  );
  for (const [index, toolCall] of [changed, created].entries()) {
    observeCursorUpdate(
      { type: 'tool-call-completed', callId: `edit-${index}`, modelCallId: 'm', toolCall },
      tracker,
    );
  }
  assert.deepEqual(
    issued.map(({ [ROW_TOKEN]: _token, ...input }) => input),
    [
      {
        kind: 'Edit',
        file_path: '/work/project/sample.txt',
        old_string: 'one\nalpha\nthree\nfour',
        new_string: 'one\nbeta\nthree\nfour',
        native: { path: '/work/project/sample.txt' },
      },
      {
        kind: 'Write',
        file_path: '/work/project/created.txt',
        content: 'hello\nworld',
        native: { path: '/work/project/created.txt' },
      },
    ],
  );
});

test('edit diffs: several hunks, no-newline markers, counts only, failures', () => {
  const edit = (value: Record<string, unknown>, status = 'success'): CursorToolCall =>
    ({
      type: 'edit',
      args: { path: '/w/a.txt' },
      result: status === 'success' ? { status, value } : { status, error: 'denied' },
    }) as CursorToolCall;
  assert.deepEqual(
    cursorEditMirror(
      edit({
        diffString:
          '--- a//w/a.txt\n+++ b//w/a.txt\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -9 +9 @@\n-z\n\\ No newline at end of file\n+Z',
      }),
    ),
    { fields: { old_string: 'a\nb\nz', new_string: 'A\nb\nZ' } },
  );
  assert.deepEqual(cursorEditMirror(edit({ diffString: '--- /dev/null\n+++ b//w/e' })), {
    kind: 'Write',
    fields: { content: '' },
  });
  // Counts without a diff leave the row to the reported counts in its output.
  assert.equal(cursorEditMirror(edit({ linesAdded: 2, linesRemoved: 1 })), undefined);
  assert.equal(cursorEditMirror(edit({}, 'error')), undefined);
  assert.equal(cursorEditMirror(shell), undefined);
});

test('only native compaction remains a mid-run transcript notice', () => {
  assert.equal(cursorContextNotice({ type: 'summary-started' }), '[Cursor] Compacting context…');
  assert.equal(cursorContextNotice({ type: 'summary-completed' }), '[Cursor] Context compacted.');
  assert.equal(cursorContextNotice(started('shell-1', shell)), undefined);
});

test('the transcript summary counts actions and lists changed files and failures, bounded', () => {
  const { tracker } = recorded();
  assert.equal(tracker.text(), '');
  for (let index = 0; index < 12; index++) {
    observeCursorUpdate(
      {
        type: 'tool-call-completed',
        callId: `edit-${index}`,
        modelCallId: 'model-1',
        toolCall: {
          type: 'edit',
          args: { path: `file-${index}.ts` },
          result: { status: 'success', value: {} },
        },
      },
      tracker,
    );
  }
  observeCursorUpdate(
    {
      type: 'tool-call-completed',
      callId: 'shell-1',
      modelCallId: 'model-1',
      toolCall: { ...shell, result: { status: 'error', error: 'blocked by policy' } },
    },
    tracker,
  );
  const text = tracker.text();
  assert.match(text, /^\n\n\[Cursor\] 13 native actions: 12 edit, 1 shell\.\n/);
  assert.match(text, /\[Cursor\] Changed: file-0\.ts, .*file-7\.ts\.\n/);
  assert.doesNotMatch(text, /file-8\.ts/);
  assert.match(text, /\[Cursor\] Not completed: Shell: printf hello \(denied\)\.\n$/);
});

const models = cursorModelOptions([{ id: 'progress-test', displayName: 'Progress' }]);
const body: MessagesRequest = {
  model: models[0].model,
  stream: true,
  messages: [{ role: 'user', content: 'inspect the fixture' }],
};

function fakeRun(result: Promise<RunResult>): Run {
  return {
    id: 'run-progress',
    agentId: 'agent-progress',
    status: 'running',
    wait: () => result,
    cancel: async () => {},
    async *stream() {},
    conversation: async () => [],
    supports: () => true,
    unsupportedReason: () => undefined,
    onDidChangeStatus: () => () => {},
  };
}

test('a Cursor action becomes a display row under its native name; later text is deferred', async (t) => {
  const updates: InteractionUpdate[] = [
    { type: 'text-delta', text: 'Inspecting. ' },
    started('read', { type: 'read', args: { path: 'a.txt' } }),
    {
      type: 'tool-call-completed',
      callId: 'read',
      modelCallId: 'model-1',
      toolCall: {
        type: 'read',
        args: { path: 'a.txt' },
        result: { status: 'success', value: { fileSize: 1, content: 'CONTENT', totalLines: 1 } },
      },
    },
    { type: 'text-delta', text: 'done' },
  ];
  let sends = 0;
  const createAgent = async () => ({
    agentId: 'agent-progress',
    close() {},
    async send(_prompt: unknown, options?: SendOptions) {
      sends++;
      for (const update of updates) {
        await options?.onDelta?.({ update });
      }
      return fakeRun(Promise.resolve({ id: 'run-progress', status: 'finished', result: 'done' }));
    },
  });
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'native-cursor-progress-'));
  const harness = new CursorHarness(models, {
    cwd: process.cwd(),
    stateDirectory,
    createAgent,
    resumeAgent: createAgent,
  });
  t.after(async () => {
    await harness.close();
    await removeTemporary(stateDirectory);
  });
  const rows = new DisplayRows();
  rows.announce(CURSOR_TOOLS);
  rows.acknowledge(['read']);
  const scope = JSON.stringify(['session', 'worker']);
  const events: Array<[string, unknown]> = [];
  const emit: Emit = (name, value) => {
    events.push([name, structuredClone(value)]);
  };
  const response = await harness.handle(
    body,
    scope,
    new AbortController().signal,
    emit,
    { permissionMode: 'plan' },
    (observation) =>
      observation.type === 'completed' ? rows.issue(scope, observation.row) : undefined,
  );
  assert.deepEqual(
    response.content.map((block) => block.type),
    ['text', 'tool_use'],
  );
  const [text, row] = response.content;
  assert.ok(text?.type === 'text' && row?.type === 'tool_use');
  assert.equal(text.text, 'Inspecting. ');
  assert.equal(row.name, 'mcp__multi-core__read');
  const input = row.input as Record<string, unknown>;
  assert.equal(input.kind, 'Read');
  assert.equal(input.file_path, 'a.txt');
  assert.equal((input.native as Record<string, unknown>).path, 'a.txt');
  assert.deepEqual(rows.verify('session', input[ROW_TOKEN], row.id), {
    output: 'CONTENT',
    isError: false,
  });
  assert.equal(rows.verify('other-session', input[ROW_TOKEN], row.id), undefined);
  assert.equal(response.multi_followup, 'done\n\n[Cursor] 1 native action: 1 read.\n');
  const streamed = JSON.stringify(events);
  assert.match(streamed, /mcp__multi-core__read/);
  assert.doesNotMatch(
    streamed,
    /"text":"done"|CONTENT/,
    'deferred text and output are not streamed',
  );
  assert.equal(sends, 1);
});

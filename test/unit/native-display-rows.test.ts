import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { antigravityPermissionPolicy } from '../../plugins/multi-antigravity/src/permissions.ts';
import { antigravityHistoryHash } from '../../plugins/multi-antigravity/src/request.ts';
import {
  DISPLAY_TOOL_SERVER,
  DisplayRows,
  displayFollowUp,
  mirroredInput,
  ROW_TOKEN,
  withoutDisplayTools,
} from '../../plugins/multi-core/src/gateway/display-rows.ts';
import { historyRewound } from '../../plugins/multi-core/src/gateway/harness-notices.ts';
import type {
  MessagesRequest,
  MessagesResponse,
} from '../../plugins/multi-core/src/gateway/messages.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import { cursorPermissionPolicy } from '../../plugins/multi-cursor/src/permissions.ts';
import { grokPermissionPolicy } from '../../plugins/multi-grok/src/permissions.ts';

const row = {
  type: 'tool_use' as const,
  id: 'toolu_multi_11111111111111111111111111111111',
  name: 'mcp__multi-core__run_command',
  input: { CommandLine: 'echo hi', [ROW_TOKEN]: 'token' },
};
const result = {
  type: 'tool_result',
  tool_use_id: 'toolu_multi_11111111111111111111111111111111',
  content: 'hi',
};
const reminder = '<system-reminder>\nMCP Server Instructions\n</system-reminder>';

test('rows are issued only for registered native tools, with bounded native input and a verified token', () => {
  const rows = new DisplayRows();
  rows.announce(['run_command', 'view_file', 'x'.repeat(48), 'bad name', 7]);
  assert.deepEqual(rows.catalog().names, ['run_command', 'view_file']);
  const scope = JSON.stringify(['session', 'worker']);
  const native = {
    tool: 'run_command',
    input: { CommandLine: 'echo hi' },
    output: 'hi',
    error: false,
  };
  assert.equal(rows.issue(scope, native), undefined, 'unregistered tools write no row');
  rows.acknowledge(['run_command', 'never_offered']);
  const issued = rows.issue(scope, {
    ...native,
    input: { CommandLine: 'y'.repeat(5000), [ROW_TOKEN]: 'forged', nested: { a: 1 } },
  });
  assert.ok(issued);
  assert.equal(issued.name, 'mcp__multi-core__run_command');
  assert.match(issued.id, /^toolu_multi_[a-f0-9]{32}$/);
  const input = issued.input;
  const kept = input.native as Record<string, unknown>;
  assert.equal(input.kind, 'Bash');
  assert.equal(String(input.command).length, 2001);
  assert.equal(String(kept.CommandLine).length, 2001);
  assert.deepEqual(kept.nested, { a: 1 });
  assert.equal(kept[ROW_TOKEN], undefined);
  assert.notEqual(input[ROW_TOKEN], 'forged');
  assert.deepEqual(rows.verify('session', input[ROW_TOKEN], issued.id), {
    output: 'hi',
    isError: false,
  });
  assert.equal(rows.verify('session', 'forged', issued.id), undefined);
  assert.equal(rows.verify('session', input[ROW_TOKEN], 'toolu_other'), undefined);
  // An action whose completion never arrived is flagged, neither failed nor a success.
  const unconfirmed = rows.issue(scope, { ...native, unconfirmed: true });
  assert.equal(unconfirmed?.input.unconfirmed, true);
  assert.equal(unconfirmed?.input.failed, undefined);
  assert.equal(input.unconfirmed, undefined);
  rows.forgetSession('session');
  assert.equal(rows.verify('session', input[ROW_TOKEN], issued.id), undefined);
  assert.equal(
    rows.issue(scope, { ...native, tool: 'never_offered' }),
    undefined,
    'a name the gateway never offered cannot be acknowledged',
  );
});

/** Every finished `agy` tool step in a captured stream, as the harness reports it. */
function agySteps(name: string) {
  return readFileSync(new URL(`./fixtures/antigravity/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).step_update)
    .filter((step) => step?.step_type === 'tool' && step.state === 'DONE')
    .map((step) => ({ tool: step.tool_name as string, info: step.tool_info }));
}

test('captured agy steps mirror Read and Bash, the native parameters kept under `native`', () => {
  const steps = ['stream-success.jsonl', 'stream-failure.jsonl', 'calls-gemini.jsonl'].flatMap(
    agySteps,
  );
  assert.ok(steps.length >= 6);
  for (const { tool, info } of steps) {
    const input = mirroredInput(tool, info.parameters);
    assert.deepEqual(input.native, info.parameters);
    if (tool === 'view_file') {
      assert.deepEqual(input, {
        kind: 'Read',
        file_path: info.parameters.AbsolutePath,
        native: info.parameters,
      });
    } else {
      assert.equal(tool, 'run_command');
      assert.deepEqual(input, {
        kind: 'Bash',
        command: info.parameters.CommandLine,
        native: info.parameters,
      });
    }
  }
  const rows = new DisplayRows();
  rows.announce(['run_command']);
  rows.acknowledge(['run_command']);
  const failed = steps.find((step) => step.info.parameters.CommandLine === 'cat /nonexistent/file');
  assert.ok(failed);
  const issued = rows.issue(JSON.stringify(['session']), {
    tool: failed.tool,
    input: failed.info.parameters,
    output: failed.info.output,
    error: true,
  });
  assert.equal(issued?.input.failed, true, 'a failed action says so in its row');
  assert.equal(issued?.input.command, 'cat /nonexistent/file');
});

test('agy edits, searches and listings mirror Edit, Write, Grep, Glob and LS', () => {
  assert.deepEqual(
    mirroredInput('view_file', { AbsolutePath: '/w/a.ts', StartLine: 10, EndLine: 19 }),
    {
      kind: 'Read',
      file_path: '/w/a.ts',
      offset: 10,
      limit: 10,
      native: { AbsolutePath: '/w/a.ts', StartLine: 10, EndLine: 19 },
    },
  );
  const replace = { TargetFile: '/w/a.ts', TargetContent: 'a', ReplacementContent: '' };
  assert.deepEqual(mirroredInput('replace_file_content', replace), {
    kind: 'Edit',
    file_path: '/w/a.ts',
    old_string: 'a',
    new_string: '',
    native: replace,
  });
  const chunks = {
    TargetFile: '/w/a.ts',
    ReplacementChunks: [
      { TargetContent: 'a', ReplacementContent: 'A' },
      { TargetContent: 'b', ReplacementContent: 'B' },
    ],
  };
  assert.deepEqual(
    [mirroredInput('multi_replace_file_content', chunks)].map(
      ({ kind, old_string, new_string }) => ({ kind, old_string, new_string }),
    ),
    [{ kind: 'Edit', old_string: 'a\nb', new_string: 'A\nB' }],
  );
  assert.equal(
    mirroredInput('write_to_file', { TargetFile: '/w/b.ts', CodeContent: 'x\ny' }).content,
    'x\ny',
  );
  const grep = { SearchPath: '/w', Query: 'TODO', Includes: ['*.ts', '*.md'] };
  assert.deepEqual(mirroredInput('grep_search', grep), {
    kind: 'Grep',
    pattern: 'TODO',
    path: '/w',
    glob: '*.ts,*.md',
    native: grep,
  });
  const find = { SearchDirectory: '/w', Pattern: '*.md' };
  assert.deepEqual(mirroredInput('find_by_name', find), {
    kind: 'Glob',
    pattern: '*.md',
    path: '/w',
    native: find,
  });
  assert.deepEqual(mirroredInput('list_dir', { DirectoryPath: '/w' }), {
    kind: 'LS',
    path: '/w',
    native: { DirectoryPath: '/w' },
  });
  // A tool with no built-in equivalent keeps only its native parameters.
  assert.deepEqual(mirroredInput('open_browser_url', { Url: 'https://a.test' }), {
    native: { Url: 'https://a.test' },
  });
  assert.deepEqual(mirroredInput('toString', { a: 1 }), { native: { a: 1 } });
});

test('Cursor SDK and Grok tool arguments mirror the same built-ins', () => {
  const cursor: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['shell', { command: 'ls', workingDirectory: '/w' }, { kind: 'Bash', command: 'ls' }],
    ['read', { path: '/w/a.ts' }, { kind: 'Read', file_path: '/w/a.ts' }],
    [
      'grep',
      { pattern: 'x', path: 'src', glob: '*.ts', outputMode: 'content' },
      { kind: 'Grep', pattern: 'x', path: 'src', glob: '*.ts' },
    ],
    [
      'glob',
      { globPattern: '**/*.md', targetDirectory: '/w' },
      { kind: 'Glob', pattern: '**/*.md', path: '/w' },
    ],
    ['ls', { path: '/w' }, { kind: 'LS', path: '/w' }],
    ['edit', { path: '/w/a.ts' }, { kind: 'Edit', file_path: '/w/a.ts' }],
    [
      'write',
      { path: '/w/b.ts', fileText: 'hi\n' },
      { kind: 'Write', file_path: '/w/b.ts', content: 'hi\n' },
    ],
    // Grok's announced tools.
    ['run_terminal_command', { command: 'echo hi' }, { kind: 'Bash', command: 'echo hi' }],
    ['read_file', { path: 'README.md' }, { kind: 'Read', file_path: 'README.md' }],
    ['list_dir', { path: '.' }, { kind: 'LS', path: '.' }],
    [
      'search_replace',
      { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
      { kind: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' },
    ],
  ];
  for (const [tool, args, expected] of cursor) {
    assert.deepEqual(mirroredInput(tool, args), { ...expected, native: args }, tool);
  }
});

/** A real Composer 2.5 run: seven rows as the gateway persisted them (paths rewritten). */
const cursorSession = JSON.parse(
  readFileSync(new URL('fixtures/cursor/session-all-kinds.json', import.meta.url), 'utf8'),
) as { response: { content: Array<{ name: string; input: Record<string, unknown> }> } };

test('a real Cursor run: every row mirrors its built-in from the native args it carried', () => {
  const rows = cursorSession.response.content;
  assert.deepEqual(
    rows.map((row) => row.name.replace('mcp__multi-core__', '')),
    ['grep', 'glob', 'read', 'shell', 'edit', 'edit', 'shell'],
  );
  for (const row of rows) {
    const { native, [ROW_TOKEN]: _token, ...mirrored } = row.input;
    const tool = row.name.replace('mcp__multi-core__', '');
    assert.deepEqual(mirroredInput(tool, native), { ...mirrored, native }, tool);
  }
  const kinds = rows.map((row) => row.input.kind);
  assert.deepEqual(kinds, ['Grep', 'Glob', 'Read', 'Bash', 'Edit', 'Edit', 'Bash']);
});

test('fields derived from a result take precedence, and may name another built-in', () => {
  const native = { path: '/work/project/sample.txt' };
  assert.deepEqual(
    mirroredInput('edit', native, { fields: { old_string: 'alpha', new_string: 'beta' } }),
    {
      kind: 'Edit',
      file_path: '/work/project/sample.txt',
      old_string: 'alpha',
      new_string: 'beta',
      native,
    },
  );
  const created = { path: '/work/project/created.txt' };
  assert.deepEqual(
    mirroredInput('edit', created, { kind: 'Write', fields: { content: 'hello\nworld' } }),
    {
      kind: 'Write',
      file_path: '/work/project/created.txt',
      content: 'hello\nworld',
      native: created,
    },
  );
  const long = mirroredInput('edit', native, { fields: { new_string: 'x'.repeat(20_000) } });
  assert.equal(String(long.new_string).length, 16 * 1024 + 1);
  const rows = new DisplayRows();
  rows.announce(['edit']);
  rows.acknowledge(['edit']);
  const issued = rows.issue('["s"]', {
    tool: 'edit',
    input: created,
    output: '--- /dev/null',
    error: false,
    mirror: { kind: 'Write', fields: { content: 'hello' } },
  });
  assert.equal(issued?.input.kind, 'Write');
  assert.equal(issued?.input.content, 'hello');
});

test('no provider sees display tools: they leave `tools`, the history and the ToolSearch catalogue', () => {
  const body: MessagesRequest = {
    model: 'claude-test',
    tools: [
      { name: 'Read', input_schema: {} },
      { name: 'mcp__multi-core__run_command', input_schema: {}, defer_loading: true },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'The following deferred tools are now available:\nWebFetch\nmcp__multi-core__view_file\n',
          },
          { type: 'text', text: '- antigravity-x: worker (Tools: Read, Bash, mcp__multi-core)' },
          { type: 'text', text: 'work' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Working. ' }, row] },
      { role: 'user', content: [result] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { role: 'user', content: 'next' },
    ],
  };
  const stripped = withoutDisplayTools(body);
  assert.deepEqual(
    stripped.tools?.map((tool) => tool.name),
    ['Read'],
  );
  assert.deepEqual(stripped.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'The following deferred tools are now available:\nWebFetch\n' },
        { type: 'text', text: '- antigravity-x: worker (Tools: Read, Bash)' },
        { type: 'text', text: 'work' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Working. ' },
        { type: 'text', text: 'Done.' },
      ],
    },
    { role: 'user', content: 'next' },
  ]);
  assert.doesNotMatch(JSON.stringify(stripped), /mcp__multi-core/);
  const ordinary: MessagesRequest = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(withoutDisplayTools(ordinary), ordinary, 'ordinary requests are untouched');
  const malformed = { model: 'x', tools: {} } as unknown as MessagesRequest;
  assert.equal(withoutDisplayTools(malformed), malformed);
});

test('a request that only answers display rows is recognised as their follow-up', () => {
  const base = [
    { role: 'user', content: 'work' },
    { role: 'assistant', content: [row] },
  ];
  assert.deepEqual(displayFollowUp({ messages: [...base, { role: 'user', content: [result] }] }), [
    'toolu_multi_11111111111111111111111111111111',
  ]);
  assert.deepEqual(
    displayFollowUp({
      messages: [...base, { role: 'user', content: [result, { type: 'text', text: reminder }] }],
    }),
    ['toolu_multi_11111111111111111111111111111111'],
    'a system reminder beside the results is not a user turn',
  );
  assert.deepEqual(
    displayFollowUp({
      messages: [
        ...base,
        { role: 'user', content: [result] },
        {
          role: 'system',
          content: [{ type: 'text', text: '<total_tokens>1 left</total_tokens>' }],
        },
      ],
    }),
    ['toolu_multi_11111111111111111111111111111111'],
    'Claude Code appends its environment as a trailing system turn',
  );
  assert.equal(
    displayFollowUp({
      messages: [...base, { role: 'user', content: [result, { type: 'text', text: 'and then?' }] }],
    }),
    undefined,
    'a prompt typed during the run starts a real turn',
  );
  assert.equal(
    displayFollowUp({
      messages: [
        { role: 'user', content: 'work' },
        { role: 'assistant', content: [{ ...row, name: 'Bash' }] },
        { role: 'user', content: [result] },
      ],
    }),
    undefined,
    'results of real tools are never answered here',
  );
  const forged = { ...row, id: 'toolu_01Forged' };
  assert.equal(
    displayFollowUp({
      messages: [
        { role: 'user', content: 'work' },
        { role: 'assistant', content: [forged] },
        { role: 'user', content: [{ ...result, tool_use_id: forged.id }] },
      ],
    }),
    undefined,
    'a model-originated call to a display name is not a row; its refusal goes back to the model',
  );
  assert.deepEqual(
    withoutDisplayTools({
      messages: [
        { role: 'user', content: 'work' },
        { role: 'assistant', content: [forged] },
        { role: 'user', content: [{ ...result, tool_use_id: forged.id }] },
      ],
    }).messages?.[1],
    { role: 'assistant', content: [forged] },
  );
  assert.equal(displayFollowUp({ messages: [{ role: 'user', content: 'hi' }] }), undefined);
});

test('the display-row grant maps to no native tool in any harness permission mapper', () => {
  const tools = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', DISPLAY_TOOL_SERVER];
  const context = { permissionMode: 'auto' as const, tools };
  assert.deepEqual(
    cursorPermissionPolicy(context).tools,
    cursorPermissionPolicy({ ...context, tools: tools.slice(0, 6) }).tools,
  );
  assert.deepEqual(
    antigravityPermissionPolicy(context),
    antigravityPermissionPolicy({ ...context, tools: tools.slice(0, 6) }),
  );
  assert.deepEqual(
    grokPermissionPolicy(context),
    grokPermissionPolicy({ ...context, tools: tools.slice(0, 6) }),
  );
  // A display name alone grants nothing native.
  assert.deepEqual(
    cursorPermissionPolicy({ permissionMode: 'auto', tools: ['mcp__multi-core__shell'] }).tools,
    [],
  );
});

test('a reply with rows and its follow-up count as the previous answer in the outer history', () => {
  const response: MessagesResponse = {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'multi/antigravity/test',
    content: [{ type: 'text', text: 'Working. ' }, row],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    multi_followup: 'Done.',
  };
  const history = withoutDisplayTools({
    messages: [
      { role: 'user', content: 'work' },
      { role: 'assistant', content: response.content },
      { role: 'user', content: [result] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { role: 'user', content: 'next' },
    ],
  }).messages;
  assert.equal(historyRewound({ response }, history ?? [], antigravityHistoryHash), false);
  assert.equal(
    historyRewound(
      { response: { ...response, multi_followup: 'Other.' } },
      history ?? [],
      antigravityHistoryHash,
    ),
    true,
  );
});

test('the gateway forwards Anthropic requests without display tools or rows', async (t) => {
  let forwarded: MessagesRequest | undefined;
  const server = createNativeGateway({
    token: 'rows-token',
    authFile: 'unused',
    fetchImpl: async (_url, init) => {
      forwarded = JSON.parse(String(init.body)) as MessagesRequest;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: { 'x-multi-gateway-token': 'rows-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-test',
      tools: [
        { name: 'Read', input_schema: {} },
        { name: 'mcp__multi-core__view_file', input_schema: {} },
      ],
      messages: [
        { role: 'user', content: 'work' },
        { role: 'assistant', content: [{ type: 'text', text: 'Read it.' }, row] },
        { role: 'user', content: [result, { type: 'text', text: 'Now summarise.' }] },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.ok(forwarded);
  assert.doesNotMatch(
    JSON.stringify(forwarded),
    /mcp__multi-core|toolu_multi_11111111111111111111111111111111/,
  );
  assert.deepEqual(forwarded.messages?.at(-1), {
    role: 'user',
    content: [{ type: 'text', text: 'Now summarise.' }],
  });
});

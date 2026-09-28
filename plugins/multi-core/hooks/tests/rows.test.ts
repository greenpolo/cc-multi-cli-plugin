import { expect, mock, test } from 'claude-code/testing';
import { syncDisplayTools } from '../rows.ts';

const gatewayEnv = {
  MULTI_GATEWAY_TOKEN: 'test-token',
  MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
};
const issuedToken = 'a'.repeat(32);
const tool = 'mcp__multi-core__run_command';

type Fetched = { url: string; body: Record<string, unknown> | undefined };

/** A gateway that offers two native tools and answers only the token it issued. */
function gateway(on: Parameters<Parameters<typeof test>[1]>[1], rows: Record<string, unknown>) {
  const fetched: Fetched[] = [];
  mock.env(on, gatewayEnv);
  on('session.id', () => ({ value: 'rows-session' }));
  on('session.cwd', () => ({ value: '/workspace' }));
  on('session.model', () => ({ value: 'multi/antigravity/gemini-3.8-flash' }));
  on('command.register', (_$, event) => ({ value: { command: event.name } }));
  on('http.fetch', (_$, event) => {
    const sent = event.init?.body;
    const body = sent ? (JSON.parse(String(sent)) as Record<string, unknown>) : undefined;
    fetched.push({ url: event.url, body });
    const reply = (status: number, value: unknown) => ({
      value: { ok: status === 200, status, headers: {}, text: JSON.stringify(value) },
    });
    if (event.url.includes('/multi/mod/display-tools') && !body) {
      return reply(200, { revision: 2, names: ['run_command', 'view_file', 'not a name'] });
    }
    if (event.url.endsWith('/multi/mod/display')) {
      // A call raised here gets an engine-minted id; `*` answers whatever id it carries.
      const row =
        body?.token === issuedToken ? (rows[String(body.toolUseId)] ?? rows['*']) : undefined;
      return row ? reply(200, row) : reply(403, { error: 'not issued' });
    }
    return reply(200, { accepted: true });
  });
  return fetched;
}

test('session start registers the native tools the gateway offers and acknowledges them', async ($, on) => {
  const fetched = gateway(on, {});
  const registered: string[] = [];
  on('tool.register', (_$, event) => {
    registered.push(event.name);
    return { value: { tool: `mcp__multi-core__${event.name}` } };
  });
  on('session.start', () => ({ cwd: '/workspace' }));
  await $.session.start({ cwd: '/workspace' });
  expect(registered.sort()).toEqual(['run_command', 'view_file']);
  const acknowledgement = fetched.find(
    (item) => item.url.endsWith('/multi/mod/display-tools') && item.body,
  );
  expect(fetched.some((item) => item.url.includes('/multi/mod/display-tools') && !item.body)).toBe(
    true,
  );
  expect(acknowledgement?.body).toEqual({
    sessionId: 'rows-session',
    registered: ['run_command', 'view_file'],
  });
});

test('tool.describe keeps display rows behind ToolSearch and leaves other tools alone', async ($, on) => {
  gateway(on, {});
  on('tool.describe', (_$, event) => ({ description: event.description }));
  const provider = { plugin: 'multi-core', tier: 'user' as const };
  const display = await $.tool.describe({ tool, description: 'row', provider });
  expect(display.isDeferred).toBe(true);
  const other = await $.tool.describe({
    tool: 'Bash',
    description: 'shell',
    provider: { plugin: 'engine', tier: 'core' },
  });
  expect(other.isDeferred).toBeUndefined();
});

test('a model-originated call to a display row is denied at check and at call', async ($, on) => {
  gateway(on, { toolu_row: { output: 'hi', isError: false } });
  on('tool.check', () => ({ decision: 'allow' as const }));
  on('tool.call', () => ({ result: 'core ran it' }));
  const withoutToken = await $.tool.check({
    tool,
    input: { CommandLine: 'rm -rf /' },
    tool_use_id: 'toolu_model',
  });
  expect(withoutToken.decision).toBe('deny');
  expect(withoutToken.reason).toContain('Only the Multi gateway originates it');
  const forged = await $.tool.check({
    tool,
    input: { CommandLine: 'rm -rf /', multi_row: 'b'.repeat(32) },
    tool_use_id: 'toolu_row',
  });
  expect(forged.decision).toBe('deny');
  const called = await $.tool.call({ tool, CommandLine: 'rm -rf /' } as never);
  expect(called.deny).toContain('not a tool a model can call');
  // Real tools pass through untouched.
  const bash = await $.tool.check({ tool: 'Bash', input: { command: 'ls' } });
  expect(bash.decision).toBe('allow');
});

test('a gateway-originated row is allowed and answered with the native output', async ($, on) => {
  gateway(on, { toolu_row: { output: 'hi\n', isError: false } });
  const check = await $.tool.check({
    tool,
    input: { CommandLine: 'echo hi', multi_row: issuedToken },
    tool_use_id: 'toolu_row',
  });
  expect(check.decision).toBe('allow');
});

test('a gateway-originated row answers its native output, and a failed action as an error', async ($, on) => {
  gateway(on, { '*': { output: 'cat: missing: No such file', isError: true } });
  const called = await $.tool.call({
    tool,
    CommandLine: 'cat missing',
    multi_row: issuedToken,
  } as never);
  expect(called.deny).toBeUndefined();
  expect(called.isError).toBe(true);
  expect(String(called.result)).toContain('No such file');
});

const surfaces = ['terminal', 'desktop'] as const;
const idle = { isRunning: false, isErrored: false, isInterrupted: false };

/**
 * Claude Code's own tool row, element for element, as captured from this build's
 * terminal (2.1.280, `tmux capture-pane -e`): `ESC[38;5;114m●` (theme `success`),
 * `ESC[1mRead ESC[0m` then `(README.md)` in the text colour; an error row's dot is
 * `ESC[38;5;211m` (theme `error`).
 */
function builtinHeader(name: string, argument: string, color = 'success') {
  return {
    type: 'Box',
    props: { flexDirection: 'row' },
    children: [
      {
        type: 'Box',
        props: { minWidth: 2 },
        children: [{ type: 'Text', props: { color }, children: ['●'] }],
      },
      { type: 'Text', props: { bold: true }, children: [name] },
      { type: 'Text', children: [`(${argument})`] },
    ],
  };
}

/**
 * The result under it: `ESC[38;5;246m  ⎿ ` and a no-break space (theme `inactive`), the result
 * beside it, `Read ESC[1m5ESC[0m lines` for Read, continuation lines under it.
 */
function builtinResult(lines: unknown[]) {
  return {
    type: 'Box',
    props: { flexDirection: 'row' },
    children: [
      {
        type: 'Box',
        props: { minWidth: 5 },
        children: [{ type: 'Text', props: { color: 'inactive' }, children: ['  ⎿ \u00a0'] }],
      },
      { type: 'Box', props: { flexDirection: 'column', flexGrow: 1 }, children: lines },
    ],
  };
}

function counted(before: string, value: number, after: string) {
  return {
    type: 'Text',
    children: [before, { type: 'Text', props: { bold: true }, children: [String(value)] }, after],
  };
}

/** The drawn tree with the native tool's name put back to the built-in's. */
function relabelled(tree: unknown, native: string, builtin: string): unknown {
  return JSON.parse(JSON.stringify(tree).replaceAll(`"${native}"`, `"${builtin}"`));
}

type Mount = Parameters<Parameters<typeof test>[1]>[0];

async function header(
  $: Mount,
  surface: (typeof surfaces)[number],
  name: string,
  input: Record<string, unknown>,
  props = idle,
) {
  const row = await $.ui.mount({
    plugin: 'multi-core',
    surface,
    component: 'ToolUse',
    requestId: `toolu_${name}`,
    props: {
      tool_use_id: `toolu_${name}`,
      tool: `mcp__multi-core__${name}`,
      input: { ...input, multi_row: issuedToken },
      ...props,
    },
  });
  const drawn = await row.drawn();
  expect(await row.find({ type: 'Text', text: /mcp__|multi_row|a{32}/ })).toBeUndefined();
  await row.unmount();
  return drawn;
}

async function result(
  $: Mount,
  surface: (typeof surfaces)[number],
  name: string,
  text: string,
  isErrored = false,
) {
  const row = await $.ui.mount({
    plugin: 'multi-core',
    surface,
    component: 'ToolResult',
    requestId: `toolu_${name}`,
    props: {
      tool_use_id: `toolu_${name}`,
      tool: `mcp__multi-core__${name}`,
      output: [{ type: 'text', text }],
      isErrored,
    },
  });
  const drawn = await row.drawn();
  await row.unmount();
  return drawn;
}

/** The engine beneath the mod: what it was asked to draw, and a stand-in for its drawing. */
function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const drawn: Array<Record<string, unknown>> = [];
  on('ui.render', (_$, event) => {
    drawn.push(event.props as Record<string, unknown>);
    return { type: 'engine', ref: 0 } as never;
  });
  return drawn;
}

test('an agy view_file row draws exactly as Claude draws Read, but for its name', async ($, on) => {
  gateway(on, {});
  const input = {
    kind: 'Read',
    file_path: '/workspace/README.md',
    native: { AbsolutePath: '/workspace/README.md' },
  };
  for (const surface of surfaces) {
    const drawn = await header($, surface, 'view_file', input);
    expect(drawn).toEqual(builtinHeader('view_file', 'README.md'));
    expect(relabelled(drawn, 'view_file', 'Read')).toEqual(builtinHeader('Read', 'README.md'));
    // agy reports what it read as `2 lines, 6 bytes`; Read says `Read 2 lines`.
    expect(await result($, surface, 'view_file', '2 lines, 6 bytes')).toEqual(
      builtinResult([counted('Read ', 2, ' lines')]),
    );
    const ranged = await header($, surface, 'view_file', { ...input, offset: 1, limit: 5 });
    expect(ranged).toEqual(builtinHeader('view_file', 'README.md · lines 1-5'));
  }
});

test('a shell row draws as Bash and leaves its output to the engine, compact and under ctrl+o', async ($, on) => {
  gateway(on, {});
  const asked = engine(on);
  for (const surface of surfaces) {
    const drawn = await header($, surface, 'run_command', {
      kind: 'Bash',
      command: 'echo hi',
      native: { CommandLine: 'echo hi' },
    });
    expect(relabelled(drawn, 'run_command', 'Bash')).toEqual(builtinHeader('Bash', 'echo hi'));
    expect(
      await result($, surface, 'run_command', 'hi\r\n<system-reminder>noise</system-reminder>'),
    ).toEqual({
      type: 'engine',
      ref: 0,
    });
    expect(asked.at(-1)?.output).toEqual([{ type: 'text', text: 'hi' }]);
  }
});

test('a search row draws as Grep: its pattern and path, then what it found', async ($, on) => {
  gateway(on, {});
  for (const surface of surfaces) {
    const drawn = await header($, surface, 'grep_search', {
      kind: 'Grep',
      pattern: 'TODO',
      path: '/workspace/src',
      native: { Query: 'TODO', SearchPath: '/workspace/src' },
    });
    expect(relabelled(drawn, 'grep_search', 'Grep')).toEqual(
      builtinHeader('Grep', 'pattern: "TODO", path: "src"'),
    );
    expect(
      await result($, surface, 'grep_search', 'src/a.ts:3:// TODO\nsrc/b.ts:9:// TODO\n'),
    ).toEqual(builtinResult([counted('Found ', 2, ' lines')]));
  }
});

test('a failed action draws as a failed built-in: error dot, `Error:` in the error colour', async ($, on) => {
  gateway(on, {});
  const text = (value: string) => ({ type: 'Text', props: { color: 'error' }, children: [value] });
  for (const surface of surfaces) {
    const drawn = await header($, surface, 'run_command', {
      kind: 'Bash',
      command: 'cat /nonexistent/file',
      failed: true,
      native: { CommandLine: 'cat /nonexistent/file' },
    });
    expect(relabelled(drawn, 'run_command', 'Bash')).toEqual(
      builtinHeader('Bash', 'cat /nonexistent/file', 'error'),
    );
    expect(
      await result(
        $,
        surface,
        'run_command',
        'cat: /nonexistent/file: No such file or directory\r\n',
      ),
    ).toEqual(builtinResult([text('Error: cat: /nonexistent/file: No such file or directory')]));
    // An error the engine reports carries the same drawing without the gateway's flag.
    const refused = await header(
      $,
      surface,
      'shell',
      { kind: 'Bash', command: 'rm -rf /' },
      { ...idle, isErrored: true },
    );
    expect(relabelled(refused, 'shell', 'Bash')).toEqual(
      builtinHeader('Bash', 'rm -rf /', 'error'),
    );
    expect(await result($, surface, 'shell', 'Error: denied', true)).toEqual(
      builtinResult([text('Error: denied')]),
    );
  }
});

test('writes and edits draw as Write and Update do: counts, numbered preview, diff', async ($, on) => {
  gateway(on, {});
  for (const surface of surfaces) {
    await header($, surface, 'write_to_file', {
      kind: 'Write',
      file_path: '/workspace/new.txt',
      content: 'a\nb\n',
    });
    const written = await result($, surface, 'write_to_file', 'Created new.txt');
    expect(written).toEqual(
      builtinResult([
        {
          type: 'Text',
          children: [
            'Wrote ',
            { type: 'Text', props: { bold: true }, children: ['2'] },
            ' lines',
            ' to ',
            { type: 'Text', props: { bold: true }, children: ['new.txt'] },
          ],
        },
        ...['a', 'b'].map((line, index) => ({
          type: 'Box',
          props: { flexDirection: 'row' },
          children: [
            { type: 'Text', props: { dimColor: true }, children: [` ${index + 1} `] },
            { type: 'Text', children: [line] },
          ],
        })),
      ]),
    );
    await header($, surface, 'edit', { kind: 'Edit', file_path: '/workspace/new.txt' });
    const edited = await result($, surface, 'edit', '@@ -2,2 +2,2 @@\n b\n-c\n+C\n');
    const row = await $.ui.mount({
      plugin: 'multi-core',
      surface,
      component: 'ToolResult',
      requestId: 'toolu_edit',
      props: {
        tool_use_id: 'toolu_edit',
        tool: 'mcp__multi-core__edit',
        output: [{ type: 'text', text: '@@ -2,2 +2,2 @@\n b\n-c\n+C\n' }],
        isErrored: false,
      },
    });
    expect((await row.find({ type: 'Text', text: /^Added 1 line, removed 1 line$/ }))?.text).toBe(
      'Added 1 line, removed 1 line',
    );
    expect((await row.find({ type: 'Text', text: ' 3 -' }))?.props.backgroundColor).toBe(
      'diffRemoved',
    );
    expect((await row.find({ type: 'Text', text: ' 3 +' }))?.props.backgroundColor).toBe(
      'diffAdded',
    );
    expect(await row.find({ type: 'Text', text: ' 2 ' })).toBeDefined();
    await row.unmount();
    expect(edited).toBeDefined();
  }
});

test('Cursor edits draw from their result: a created file as Write, a diff or counts as Update', async ($, on) => {
  gateway(on, {});
  // The output a Cursor edit row carries is its `EditSuccess.diffString`, as a real run reported it.
  const createdDiff =
    '--- /dev/null\n+++ b//workspace/created.txt\n@@ -1,0 +1,2 @@\n+hello\n+world';
  const changedDiff =
    '--- a//workspace/sample.txt\n+++ b//workspace/sample.txt\n@@ -1,4 +1,4 @@\n one\n-alpha\n+beta\n three\n four';
  for (const surface of surfaces) {
    await header($, surface, 'edit', {
      kind: 'Write',
      file_path: '/workspace/created.txt',
      content: 'hello\nworld',
      native: { path: '/workspace/created.txt' },
    });
    const created = await $.ui.mount({
      plugin: 'multi-core',
      surface,
      component: 'ToolResult',
      requestId: 'toolu_edit',
      props: {
        tool_use_id: 'toolu_edit',
        tool: 'mcp__multi-core__edit',
        output: [{ type: 'text', text: createdDiff }],
        isErrored: false,
      },
    });
    expect(await created.find({ type: 'Text', text: 'created.txt' })).toBeDefined();
    expect(await created.find({ type: 'Text', text: 'world' })).toBeDefined();
    expect(await created.find({ type: 'Text', text: /^Added/ })).toBeUndefined();
    await created.unmount();

    const sides = { old_string: 'one\nalpha\nthree\nfour', new_string: 'one\nbeta\nthree\nfour' };
    // Without a `diffString` the row has no sides, only the counts in its output.
    for (const [output, fields, summary] of [
      [changedDiff, sides, 'Added 1 line, removed 1 line'],
      ['+2 -1 lines', {}, 'Added 2 lines, removed 1 line'],
    ] as const) {
      await header($, surface, 'edit', {
        kind: 'Edit',
        file_path: '/workspace/sample.txt',
        ...fields,
        native: { path: '/workspace/sample.txt' },
      });
      const edited = await $.ui.mount({
        plugin: 'multi-core',
        surface,
        component: 'ToolResult',
        requestId: 'toolu_edit',
        props: {
          tool_use_id: 'toolu_edit',
          tool: 'mcp__multi-core__edit',
          output: [{ type: 'text', text: output }],
          isErrored: false,
        },
      });
      expect((await edited.find({ type: 'Text', text: /^(Added|Removed) / }))?.text).toBe(summary);
      await edited.unmount();
    }
  }
});

test('a native tool with no built-in keeps its own argument and output', async ($, on) => {
  gateway(on, {});
  const asked = engine(on);
  for (const surface of surfaces) {
    const drawn = await header($, surface, 'open_browser_url', {
      native: { Url: 'https://example.test' },
    });
    expect(drawn).toEqual(builtinHeader('open_browser_url', 'https://example.test'));
    expect(await result($, surface, 'open_browser_url', '')).toEqual({ type: 'engine', ref: 0 });
    expect(asked.at(-1)?.output).toEqual([{ type: 'text', text: '(No output)' }]);
  }
});

test('an action the run never confirmed draws neither green nor red, with an unconfirmed outcome', async ($, on) => {
  gateway(on, {});
  for (const surface of surfaces) {
    const drawn = await header($, surface, 'write_to_file', {
      kind: 'Write',
      file_path: '/workspace/a.ts',
      content: 'x\n',
      unconfirmed: true,
      native: { TargetFile: '/workspace/a.ts' },
    });
    expect(relabelled(drawn, 'write_to_file', 'Write')).toEqual(
      builtinHeader('Write', 'a.ts', 'inactive'),
    );
    expect(
      await result(
        $,
        surface,
        'write_to_file',
        "The native run ended without reporting this action's completion.",
      ),
    ).toEqual(
      builtinResult([
        {
          type: 'Text',
          props: { color: 'inactive' },
          children: [
            "Unconfirmed: the native run ended without reporting this action's completion.",
          ],
        },
      ]),
    );
  }
});

test('a failed display tool acknowledgement is retried while the catalog is unchanged', async () => {
  const acknowledged: unknown[] = [];
  let failures = 1;
  const client = {
    sessionId: async () => 'rows-session',
    catalog: async () => ({ revision: 41, names: ['ack_probe'] }),
    register: async () => ({ tool: 'mcp__multi-core__ack_probe' }),
    // The gateway client turns a timeout or an HTTP failure into `undefined`.
    acknowledge: async (payload: Record<string, unknown>) => {
      acknowledged.push(payload.registered);
      if (failures > 0) {
        failures--;
        return undefined;
      }
      return { registered: 1 };
    },
  };
  await syncDisplayTools(client);
  await syncDisplayTools(client);
  expect(acknowledged.length).toBe(2);
  expect(acknowledged[1]).toContain('ack_probe');
  // Once acknowledged, the unchanged catalog is not acknowledged again.
  await syncDisplayTools(client);
  expect(acknowledged.length).toBe(2);
});

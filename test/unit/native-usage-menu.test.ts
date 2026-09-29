import assert from 'node:assert/strict';
import test from 'node:test';

// Load the actual Mod modules without requiring Claude's host-only type package
// in the offline TypeScript project. All runtime imports in these modules are erased types.
const hooksUrl = new URL('../../plugins/multi-core/hooks/usage.ts', import.meta.url);
const viewUrl = new URL('../../plugins/multi-core/hooks/usage-view.ts', import.meta.url);
const dashboard = {
  updatedAt: 'today',
  providers: [
    {
      id: 'cursor',
      name: 'Cursor',
      status: 'ready',
      summary: '$0.00 charged',
      details: ['native spend'],
    },
  ],
};

test('usage client messages refresh props and receipts without losing providers or accepting foreign panes', async () => {
  const requests: string[] = [];
  const engine = {
    env: {
      get: async (name: string) => (name === 'MULTI_GATEWAY_TOKEN' ? 'secret' : 'http://localhost'),
    },
    session: { id: async () => 'session/one' },
    http: {
      fetch: async (url: string) => {
        requests.push(url);
        const result = url.includes('/receipts?')
          ? {
              receipts: [
                {
                  agentId: 'worker',
                  outcome: 'completed',
                  time: 'today',
                  requests: 1,
                  usage: { input_tokens: 2, output_tokens: 3 },
                },
              ],
            }
          : dashboard;
        return { ok: true, text: JSON.stringify(result) };
      },
    },
    ui: { open: async () => {}, invalidate: () => {} },
  };
  type Result = { props?: { providers: unknown[]; receiptLines?: string[] }; text?: string };
  type Hook = (
    host: typeof engine,
    event: Record<string, unknown>,
    next: () => Promise<Result>,
  ) => Promise<Result>;
  const hooks = new Map<string, Hook>();
  const module = await import(hooksUrl.href);
  module.register((name: string, _filter: unknown, hook: Hook) => hooks.set(name, hook));
  const command = hooks.get('command.run');
  const message = hooks.get('ui.message');
  assert(command && message);
  const next = async () => ({});
  await command(engine, { args: '' }, next);
  const event = {
    requestId: 'multi-usage',
    element: 'usage',
    module: 'hooks/usage-view.ts',
    data: { action: 'refresh' },
  };
  const refreshed = await message(engine, event, next);
  assert.deepEqual(refreshed.props?.providers, dashboard.providers);
  assert(requests[1].includes('refresh=true&sessionId=session%2Fone'));
  const receipts = await message(engine, { ...event, data: { action: 'receipts' } }, next);
  assert.deepEqual(receipts.props?.providers, dashboard.providers);
  assert.match(receipts.props?.receiptLines?.[0] ?? '', /worker/);
  await message(engine, { ...event, requestId: 'another-pane' }, next);
  assert.equal(requests.length, 3);
});

type Element = { type: string; props: Record<string, unknown> };
function flatten(element: Element): Element[] {
  const children = element.props.children;
  return [element, ...(Array.isArray(children) ? children.flatMap((child) => flatten(child)) : [])];
}

test('usage Client supports provider navigation, receipts and refresh without model calls', async () => {
  const posts: unknown[] = [];
  let state: { selected: string; offset: number } | undefined;
  let keyHandler: ((event: { key: string }) => void) | undefined;
  const surface = {
    elements: Object.fromEntries(
      ['Box', 'Text', 'Button'].map((name) => [
        name,
        (props: Record<string, unknown>) => ({ type: name, props }),
      ]),
    ),
    get state() {
      return state;
    },
    rows: 20,
    columns: 90,
    setState: (value: { selected: string; offset: number }) => {
      state = value;
    },
    onKey: (handler: (event: { key: string }) => void) => {
      keyHandler = handler;
    },
    post: (data: unknown) => posts.push(data),
  };
  const { default: view } = await import(viewUrl.href);
  const tree: Element = view(dashboard, surface);
  const receipts = flatten(tree).find((item) => item.props.key === 'receipts');
  assert(receipts);
  (receipts.props.onPress as () => void)();
  assert.equal(state?.selected, 'receipts');
  assert.deepEqual(posts, [{ action: 'receipts' }]);
  const receiptTree = view({ ...dashboard, receiptLines: ['worker complete'] }, surface);
  assert(JSON.stringify(receiptTree).includes('worker complete'));
  keyHandler?.({ key: 'r' });
  assert.deepEqual(posts.at(-1), { action: 'receipts' });
  keyHandler?.({ key: 'left' });
  assert.equal(state?.selected, 'cursor');
  const providerTree = view(dashboard, surface);
  assert(JSON.stringify(providerTree).includes('native spend'));
  keyHandler?.({ key: 'r' });
  assert.deepEqual(posts.at(-1), { action: 'refresh' });
});

test('quota advice is opt-in, session scoped, advisory and removed on detach', async () => {
  const module = await import(hooksUrl.href);
  let session = 'advice-one';
  let reads = 0;
  let available = true;
  const engine = {
    env: {
      get: async (name: string) => (name === 'MULTI_GATEWAY_TOKEN' ? 'secret' : 'http://localhost'),
    },
    session: { id: async () => session, model: async () => 'claude-sonnet-5' },
    http: {
      fetch: async () => {
        reads++;
        return { ok: available, text: JSON.stringify(dashboard) };
      },
    },
    ui: { open: async () => {}, invalidate: () => {} },
  };
  type Hook = (
    host: typeof engine,
    event: Record<string, unknown>,
    next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<Record<string, unknown>>;
  const hooks = new Map<string, Hook>();
  module.register((name: string, filter: unknown, handler?: Hook) => {
    hooks.set(name, typeof filter === 'function' ? (filter as Hook) : (handler as Hook));
  });
  const submit = hooks.get('classic.PreToolUse');
  const command = hooks.get('command.run');
  const message = hooks.get('ui.message');
  assert(submit && command && message);
  const next = async (event: Record<string, unknown>) => ({
    ...event,
    additionalContext: ['existing context'],
    ask: 'Existing permission review',
  });
  const prompt = {
    tool: 'Agent',
    tool_use_id: 'call-1',
    prompt: 'Delegate this task',
    model: 'chosen-model',
    subagent_type: 'cursor',
  };
  assert.deepEqual(await submit(engine, prompt, next), await next(prompt));
  assert.equal(reads, 0);
  await command(engine, { args: '' }, next);
  const toggle = {
    requestId: 'multi-usage',
    element: 'usage',
    data: { action: 'toggle-quota-advice' },
  };
  const enabled = await message(engine, toggle, next);
  assert.equal((enabled.props as { quotaAdviceEnabled: boolean }).quotaAdviceEnabled, true);
  const readsBeforeSpawn = reads;
  const informed = await submit(engine, prompt, async (event) => {
    assert.equal(reads, readsBeforeSpawn + 1);
    assert.deepEqual(event, prompt);
    return next(event);
  });
  assert.equal(informed.model, prompt.model);
  assert.equal(informed.prompt, prompt.prompt);
  assert.equal(informed.ask, 'Existing permission review');
  const context = informed.additionalContext as string[];
  assert.equal(context[0], 'existing context');
  assert.match(context[1], /lowest subscription usage/);
  assert.match(context[1], /may choose a more-used model/);
  assert.match(context[1], /without waiting/);
  assert(!context[1].includes('native spend'));
  const readsBeforeSkipped = reads;
  for (const event of [
    { ...prompt, tool: 'Read' },
    { ...prompt, agentId: 'nested-worker' },
  ]) {
    assert.deepEqual(await submit(engine, event, next), await next(event));
  }
  assert.equal(reads, readsBeforeSkipped);
  const task = { ...prompt, tool: 'Task' };
  assert.equal(((await submit(engine, task, next)).additionalContext as string[]).length, 2);
  assert.equal(reads, readsBeforeSkipped + 1);
  const beforeOther = reads;
  session = 'advice-two';
  assert.deepEqual(await submit(engine, prompt, next), await next(prompt));
  assert.equal(reads, beforeOther);
  session = 'advice-one';
  available = false;
  assert.match(
    ((await submit(engine, prompt, next)).additionalContext as string[])[1],
    /could not be retrieved/,
  );
  await message(engine, toggle, next);
  const beforeDisabled = reads;
  assert.deepEqual(await submit(engine, prompt, next), await next(prompt));
  assert.equal(reads, beforeDisabled);
  await message(engine, toggle, next);
  module.forgetUsageSession(session);
  assert.deepEqual(await submit(engine, prompt, next), await next(prompt));
  assert.equal(reads, beforeDisabled);
  assert(!hooks.has('prompt.submit'));
});

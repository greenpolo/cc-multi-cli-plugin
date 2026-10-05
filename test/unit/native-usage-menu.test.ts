import assert from 'node:assert/strict';
import test from 'node:test';

// The usage pane's hooks run in the engine and are covered by `npm run test:mod`
// (`plugins/multi-core/hooks/tests/usage.test.ts`); the Client module is plain code.
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

import type { ClientModule } from 'claude-code';

type Provider = {
  id: string;
  name: string;
  status: string;
  summary: string;
  details: string[];
  url?: string;
};
export type UsagePaneProps = {
  updatedAt: string;
  providers: Provider[];
  receiptLines?: string[];
  error?: string;
  quotaAdviceEnabled?: boolean;
};
type State = { selected: string; offset: number };

const view: ClientModule<UsagePaneProps, State> = (props, surface) => {
  const { Box, Text, Button } = surface.elements;
  const state = surface.state ?? { selected: 'all', offset: 0 };
  const tabs = [
    { id: 'all', name: 'All' },
    ...props.providers,
    { id: 'receipts', name: 'Receipts' },
  ];
  const width = Math.max(10, surface.columns || 80);
  const lines = viewLines(props, state.selected).flatMap((line) => wrapLine(line, width));
  const height = Math.max(1, (surface.rows || 20) - 8);
  const offset = Math.max(0, Math.min(state.offset, lines.length - height));
  const choose = (selected: string) => {
    surface.setState({ selected, offset: 0 });
    if (selected === 'receipts') {
      surface.post({ action: 'receipts' });
    }
  };
  const refreshAction = state.selected === 'receipts' ? 'receipts' : 'refresh';
  surface.onKey((event) => {
    if (event.key === 'r') {
      surface.post({ action: refreshAction });
    }
    if (event.key === 'up' || event.key === 'down') {
      surface.setState({ ...state, offset: Math.max(0, offset + (event.key === 'up' ? -1 : 1)) });
    }
    if (event.key === 'left' || event.key === 'right') {
      const index = tabs.findIndex((tab) => tab.id === state.selected);
      const next = tabs[(index + (event.key === 'left' ? tabs.length - 1 : 1)) % tabs.length];
      choose(next?.id ?? state.selected);
    }
  });
  return Box({
    flexDirection: 'column',
    children: [
      Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 1,
        children: tabs.map((tab) =>
          Button({
            key: tab.id,
            label: tab.id === state.selected ? `[${tab.name}]` : tab.name,
            // `autoFocus` is typed `true | absent`; passing `false` fails tree validation.
            ...(tab.id === state.selected ? { autoFocus: true as const } : {}),
            onPress: () => choose(tab.id),
          }),
        ),
      }),
      Text({ dimColor: true, children: `Account data checked ${props.updatedAt}` }),
      Button({
        key: 'quota-advice',
        label: `Quota-aware model selection: ${props.quotaAdviceEnabled ? 'On' : 'Off'}`,
        onPress: () => surface.post({ action: 'toggle-quota-advice' }),
      }),
      ...(props.error ? [Text({ color: 'yellow', children: props.error })] : []),
      ...lines.slice(offset, offset + height).map((line) => Text({ children: line })),
      Text({
        dimColor: true,
        children: `${offset + 1}–${Math.min(lines.length, offset + height)} of ${lines.length} · ←/→ providers · ↑/↓ scroll · r refresh · Esc close`,
      }),
      Button({
        key: 'refresh',
        label: 'Refresh',
        onPress: () => surface.post({ action: refreshAction }),
      }),
    ],
  });
};

function viewLines(props: UsagePaneProps, selected: string): string[] {
  if (selected === 'receipts') {
    return props.receiptLines?.length
      ? props.receiptLines
      : ['No completed receipts in this session.'];
  }
  const provider = props.providers.find((item) => item.id === selected);
  if (provider) {
    return [
      provider.name,
      provider.summary,
      ...provider.details,
      ...(provider.url ? [provider.url] : []),
    ];
  }
  return props.providers.flatMap((item) => [item.name, `  ${item.summary}`, '']);
}
export default view;

function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) {
    return [line];
  }
  const result: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    const space = remaining.lastIndexOf(' ', width);
    const end = space > 0 ? space : width;
    result.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) {
    result.push(remaining);
  }
  return result;
}

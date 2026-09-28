import type { EngineInterface, Register } from 'claude-code';
import { quotaAdvice } from './quota-advice.ts';
import type { UsagePaneProps } from './usage-view.ts';

const panes = new Map<string, UsagePaneProps>();
const advisorySessions = new Set<string>();

export function forgetUsageSession(session: string) {
  advisorySessions.delete(session);
  panes.delete(session);
}

export const register: Register = (on) => {
  on('classic.PreToolUse', async ($, event, next) => {
    // `Task` is the Agent tool's legacy name; a worker's own spawn carries its agentId.
    const tool: string = event.tool;
    if (
      (tool !== 'Agent' && tool !== 'Task') ||
      (event as { agentId?: string }).agentId !== undefined
    ) {
      return next(event);
    }
    const session = await $.session.id();
    if (!advisorySessions.has(session)) {
      return next(event);
    }
    const snapshot = dashboard(
      await request($, `/multi/mod/usage?sessionId=${encodeURIComponent(session)}&view=providers`),
    );
    const result = await next(event);
    // Preserve all permission decisions and tool arguments, including on lookup failure.
    if (!advisorySessions.has(session)) {
      return result;
    }
    return {
      ...result,
      additionalContext: [...(result.additionalContext ?? []), quotaAdvice(snapshot)],
    };
  });
  on('command.run', { command: 'multi-usage' }, async ($, event) => {
    if (event.args.trim()) {
      return { text: 'Use /multi-usage without arguments.' };
    }
    const session = await $.session.id();
    const response = dashboard(
      await request($, `/multi/mod/usage?sessionId=${encodeURIComponent(session)}&view=providers`),
    );
    if (!response) {
      return { text: 'Multi usage is unavailable. Launch this session with claude-multi.' };
    }
    if (panes.size >= 16) {
      panes.clear();
    }
    panes.set(session, { ...response, quotaAdviceEnabled: advisorySessions.has(session) });
    try {
      await $.ui.open({
        id: 'multi-usage',
        title: 'Multi usage',
        focus: true,
        closeOnEscape: true,
        rows: 20,
      });
      $.ui.invalidate('ui.render');
      return {};
    } catch {
      return {
        text: response.providers
          .map((provider) => `${provider.name}: ${provider.summary}`)
          .join('\n'),
      };
    }
  });
  on('ui.render', { component: 'Pane' }, async ($, event, next) => {
    if (event.requestId !== 'multi-usage' || event.surface !== 'terminal') {
      return next(event);
    }
    const props = panes.get(await $.session.id());
    if (!props) {
      return next(event);
    }
    const { Client } = $.ui.resolve(event);
    return Client({ key: 'usage', module: './usage-view.ts', props, width: '100%', flexGrow: 1 });
  });
  on('ui.message', { element: 'usage' }, async ($, event, next) => {
    if (event.requestId !== 'multi-usage' || event.element !== 'usage' || !record(event.data)) {
      return next(event);
    }
    const action = event.data.action;
    if (action !== 'refresh' && action !== 'receipts' && action !== 'toggle-quota-advice') {
      return next(event);
    }
    const session = await $.session.id();
    const previous = panes.get(session);
    if (!previous) {
      return next(event);
    }
    if (action === 'toggle-quota-advice') {
      const enabled = !advisorySessions.has(session);
      if (enabled) {
        advisorySessions.add(session);
      } else {
        advisorySessions.delete(session);
      }
      const props = { ...previous, quotaAdviceEnabled: enabled };
      panes.set(session, props);
      return { props };
    }
    const route =
      action === 'refresh'
        ? `/multi/mod/usage?view=providers&refresh=true&sessionId=${encodeURIComponent(session)}`
        : `/multi/mod/receipts?sessionId=${encodeURIComponent(session)}`;
    const response = await request($, route);
    const props = updatePane(previous, action, response);
    panes.set(session, props);
    return { props };
  });
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function dashboard(value: unknown): UsagePaneProps | undefined {
  if (!record(value) || typeof value.updatedAt !== 'string' || !Array.isArray(value.providers)) {
    return undefined;
  }
  if (
    !value.providers.every(
      (item) =>
        record(item) &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.status === 'string' &&
        typeof item.summary === 'string' &&
        Array.isArray(item.details) &&
        item.details.every((line) => typeof line === 'string'),
    )
  ) {
    return undefined;
  }
  return value as UsagePaneProps;
}
/** Props are plain data: a field without a value is left out, never set to undefined. */
function updatePane(previous: UsagePaneProps, action: string, response: unknown): UsagePaneProps {
  const { error: _error, ...kept } = previous;
  if (action === 'refresh') {
    const refreshed = dashboard(response);
    return refreshed
      ? {
          ...refreshed,
          ...(previous.receiptLines ? { receiptLines: previous.receiptLines } : {}),
          ...(previous.quotaAdviceEnabled === undefined
            ? {}
            : { quotaAdviceEnabled: previous.quotaAdviceEnabled }),
        }
      : { ...previous, error: 'Refresh failed. Showing the previous values.' };
  }
  if (!record(response) || !Array.isArray(response.receipts)) {
    return { ...previous, error: 'Could not load receipts.' };
  }
  return {
    ...kept,
    receiptLines: response.receipts.slice(-20).reverse().flatMap(receiptLines),
  };
}
function receiptLines(value: unknown): string[] {
  if (!record(value) || !record(value.usage)) {
    return [];
  }
  const owner = typeof value.agentId === 'string' ? value.agentId : 'Main turn';
  return [
    `${owner} · ${String(value.outcome)}${value.incomplete ? ' (incomplete)' : ''} · ${String(value.time)}`,
    `  ${receiptUsage(value.usage, value.requests, value.context)}`,
    ...(Array.isArray(value.entries) ? value.entries.flatMap(receiptEntry) : []),
  ];
}
/**
 * Context and consumption side by side: a harness that resends its whole context
 * on every model call without a cache reads as a small context and a large spend.
 */
function receiptUsage(usage: Record<string, unknown>, requests: unknown, context: unknown) {
  const count = (value: unknown) =>
    typeof value === 'number' ? value.toLocaleString('en-US') : '0';
  const calls =
    typeof usage.model_calls === 'number' ? ` · ${count(usage.model_calls)} model calls` : '';
  const window = record(context)
    ? `context ${count(
        [context.input_tokens, context.cache_read_input_tokens, context.cache_creation_input_tokens]
          .filter((item) => typeof item === 'number')
          .reduce((sum, item) => sum + item, 0),
      )} · `
    : '';
  return `${String(requests)} requests${calls} · ${window}consumed ${count(usage.input_tokens)} input · cached ${count(usage.cache_read_input_tokens)} · ${count(usage.output_tokens)} output`;
}
function receiptEntry(value: unknown): string[] {
  if (!record(value)) {
    return [];
  }
  return [
    `  ${String(value.provider)} · ${String(value.model ?? 'model unreported')} · effort ${String(value.effort ?? 'unreported')} · ${String(value.endpoint ?? 'endpoint unreported')} · ${String(value.source)}`,
  ];
}

async function request($: EngineInterface, route: string): Promise<unknown> {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  if (!base || !token) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      $.http.fetch(`${base}${route}`, {
        method: 'GET',
        headers: { 'x-multi-gateway-token': token },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Usage timeout')), 8500);
      }),
    ]);
    return result.ok ? JSON.parse(result.text) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

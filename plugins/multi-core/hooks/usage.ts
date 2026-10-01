import type { EngineInterface, Register } from 'claude-code';
import { atom, read, update } from 'claude-code';
import type { MultiCoreUsagePane } from '../types/multi-core.d.ts';
import { accepted, getJson, type Wire } from './gateway.ts';
import { quotaAdvice } from './quota-advice.ts';
import { withBounded } from './state.ts';
import type { UsagePaneProps } from './usage-view.ts';

// State values are named where they are read: the engine's scan reads an atom's plugin and key
// from this file's own source, not across an import.
const advisorySessions = atom(
  { plugin: 'multi-core', key: 'advisorySessions' } as const,
  [] as string[],
);
const usagePanes = atom(
  { plugin: 'multi-core', key: 'usagePanes' } as const,
  {} as Record<string, MultiCoreUsagePane>,
);

/** A provider dashboard can take a few seconds; the command's own budget is 10 s. */
const usageTimeoutMs = 8500;
const maximumPanes = 16;

const wire = ($: EngineInterface): Wire => ({
  url: () => $.env.get('MULTI_MOD_GATEWAY_URL'),
  token: () => $.env.get('MULTI_GATEWAY_TOKEN'),
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
});

export const register = (on: Parameters<Register>[0], _options?: Parameters<Register>[1]) => {
  on('classic.PreToolUse', async ($, event, next) => {
    // `Task` is the Agent tool's legacy name.
    const tool: string = event.tool;
    if (tool !== 'Agent' && tool !== 'Task') {
      return next(event);
    }
    const session = await $.session.id();
    if (!(await read($, advisorySessions)).includes(session)) {
      return next(event);
    }
    const snapshot = dashboard(accepted(await fetchUsage($, session)));
    const result = await next(event);
    // Preserve all permission decisions and tool arguments, including on lookup failure.
    if (!(await read($, advisorySessions)).includes(session)) {
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
    const response = dashboard(accepted(await fetchUsage($, session)));
    if (!response) {
      return { text: 'Multi usage is unavailable. Launch this session with claude-multi.' };
    }
    const quotaAdviceEnabled = (await read($, advisorySessions)).includes(session);
    // The pane draws from this state: writing it redraws an open pane without an invalidate.
    await update($, usagePanes, (held) =>
      withBounded<MultiCoreUsagePane>(
        held,
        session,
        { ...response, quotaAdviceEnabled },
        maximumPanes,
      ),
    );
    const summary = response.providers
      .map((provider) => `${provider.name}: ${provider.summary}`)
      .join('\n');
    try {
      const opened = await $.ui.open({
        id: 'multi-usage',
        title: 'Multi usage',
        focus: true,
        closeOnEscape: true,
        rows: 20,
      });
      if (opened.isPlaced) {
        return {};
      }
      // The pane waits undrawn (a surface that places no panes): say so, and show the numbers.
      $.ui.toast(`Multi usage: ${opened.reason}`);
      return { text: summary };
    } catch {
      return { text: summary };
    }
  });
  on('ui.render', { component: 'Pane' }, async ($, event, next) => {
    if (event.requestId !== 'multi-usage' || event.surface !== 'terminal') {
      return next(event);
    }
    const props = (await read($, usagePanes))[await $.session.id()];
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
    const previous = (await read($, usagePanes))[session];
    if (!previous) {
      return next(event);
    }
    if (action === 'toggle-quota-advice') {
      const enabled = !(await read($, advisorySessions)).includes(session);
      await update($, advisorySessions, (held) =>
        enabled ? [...held, session] : held.filter((id) => id !== session),
      );
      const props = { ...previous, quotaAdviceEnabled: enabled };
      await update($, usagePanes, (held) =>
        withBounded<MultiCoreUsagePane>(held, session, props, maximumPanes),
      );
      return { props };
    }
    const response =
      action === 'refresh'
        ? await fetchUsage($, session, true)
        : await getJson(
            wire($),
            '/multi/mod/receipts',
            { sessionId: session },
            { timeoutMs: usageTimeoutMs },
          );
    const props = updatePane(previous, action, accepted(response));
    await update($, usagePanes, (held) =>
      withBounded<MultiCoreUsagePane>(held, session, props, maximumPanes),
    );
    return { props };
  });
};

function fetchUsage($: EngineInterface, session: string, refresh = false) {
  const query: Record<string, string> = { sessionId: session, view: 'providers' };
  if (refresh) {
    query.refresh = 'true';
  }
  return getJson(wire($), '/multi/mod/usage', query, { timeoutMs: usageTimeoutMs });
}

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

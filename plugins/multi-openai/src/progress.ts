import type {
  NativeActionKind,
  NativeActionTracker,
} from '../../multi-core/src/gateway/harness-progress.ts';
import { isRecord } from '../../multi-core/src/gateway/record.ts';
import type { CodexItem } from './app-server.ts';

/**
 * The names Codex actions show under, one per kind of thread item Codex reports
 * (`ThreadItem` in the app-server protocol). The mod registers a display row for each.
 */
export const CODEX_TOOLS: readonly string[] = [
  'shell',
  'apply_patch',
  'mcp_tool',
  'web_search',
  'view_image',
  'image_generation',
  'spawn_agent',
  'dynamic_tool',
];

type Action = { tool: string; kind: NativeActionKind; description: string; changed?: string };

function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

function changedPaths(item: CodexItem): string[] {
  return Array.isArray(item.changes)
    ? item.changes.flatMap((change) =>
        isRecord(change) && typeof change.path === 'string' ? [change.path] : [],
      )
    : [];
}

/** What an item is, as a row: its tool name, kind and a one-line description. */
function action(item: CodexItem): Action | undefined {
  switch (item.type) {
    case 'commandExecution': {
      const command = text(item.command);
      const read = Array.isArray(item.commandActions)
        ? item.commandActions.every(
            (entry) =>
              isRecord(entry) && ['read', 'listFiles', 'search'].includes(String(entry.type)),
          ) && item.commandActions.length > 0
        : false;
      return { tool: 'shell', kind: read ? 'read' : 'shell', description: command };
    }
    case 'fileChange': {
      const paths = changedPaths(item);
      return {
        tool: 'apply_patch',
        kind: 'edit',
        description: paths.join(', ') || 'apply_patch',
        ...(paths[0] ? { changed: paths[0] } : {}),
      };
    }
    case 'mcpToolCall':
      return {
        tool: 'mcp_tool',
        kind: 'other',
        description: `${text(item.server)}.${text(item.tool)}`,
      };
    case 'dynamicToolCall':
      return { tool: 'dynamic_tool', kind: 'other', description: text(item.tool) };
    case 'webSearch':
      return { tool: 'web_search', kind: 'search', description: text(item.query) || 'web search' };
    case 'imageView':
      return { tool: 'view_image', kind: 'read', description: text(item.path) };
    case 'imageGeneration':
      return { tool: 'image_generation', kind: 'other', description: 'image generation' };
    case 'collabAgentToolCall':
      return {
        tool: 'spawn_agent',
        kind: 'other',
        description: `${text(item.tool)}${item.model ? ` · ${text(item.model)}` : ''}`,
      };
    default:
      return undefined;
  }
}

/** The input a row shows: the item as Codex reported it, without its output. */
function input(item: CodexItem): Record<string, unknown> {
  const {
    aggregatedOutput: _output,
    result: _result,
    contentItems: _content,
    status: _status,
    ...rest
  } = item;
  return rest;
}

function output(item: CodexItem): string {
  if (item.type === 'commandExecution') {
    return text(item.aggregatedOutput);
  }
  if (item.type === 'fileChange') {
    return Array.isArray(item.changes)
      ? item.changes.map((change) => (isRecord(change) ? text(change.diff) : '')).join('\n')
      : '';
  }
  if (item.type === 'mcpToolCall') {
    return text(item.error ?? item.result);
  }
  if (item.type === 'dynamicToolCall') {
    return text(item.contentItems);
  }
  return '';
}

function outcome(item: CodexItem): { outcome: string; error: boolean } {
  const status = text(item.status);
  if (item.type === 'commandExecution' && typeof item.exitCode === 'number') {
    return item.exitCode === 0
      ? { outcome: 'done', error: false }
      : { outcome: `exit ${item.exitCode}`, error: true };
  }
  if (status === 'declined') {
    return { outcome: 'refused', error: true };
  }
  if (status === 'failed' || item.success === false) {
    return { outcome: 'failed', error: true };
  }
  return { outcome: 'done', error: false };
}

/**
 * Reports one Codex item: started when Codex starts it, settled with its own output when
 * it completes. Messages, reasoning and plans are text, not actions.
 */
export function observeCodexItem(
  phase: 'started' | 'completed',
  item: CodexItem,
  tracker: NativeActionTracker,
) {
  const described = action(item);
  if (!described) {
    return;
  }
  if (!tracker.has(item.id)) {
    tracker.start(item.id, {
      kind: described.kind,
      tool: described.tool,
      input: input(item),
      description: described.description,
      ...(described.changed ? { changed: described.changed } : {}),
    });
  }
  if (phase === 'completed') {
    const result = outcome(item);
    const shown = output(item);
    tracker.finish(item.id, { ...result, output: shown || result.outcome });
  }
}

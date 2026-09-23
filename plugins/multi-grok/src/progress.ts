import type {
  NativeActionKind,
  NativeActionTracker,
} from '../../multi-core/src/gateway/harness-progress.ts';
import type { GrokStreamEvent, GrokToolCall } from './cli.ts';

// ACP tool kinds as the Grok Build CLI reports them.
const kinds: Record<string, NativeActionKind> = {
  read: 'read',
  search: 'search',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  execute: 'shell',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text a tool update carries in its content blocks. */
function grokContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((entry) => {
      const inner = isRecord(entry) && isRecord(entry.content) ? entry.content.text : undefined;
      return typeof inner === 'string' ? inner : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** The native output of a finished call: its raw output, else its content text. */
function grokOutput(call: GrokToolCall): string {
  const raw = call.rawOutput;
  if (typeof raw === 'string' && raw) {
    return raw;
  }
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return JSON.stringify(raw);
  }
  return grokContentText(call.content);
}

function editedPath(call: GrokToolCall) {
  const input = isRecord(call.rawInput) ? call.rawInput : {};
  for (const key of ['path', 'file_path', 'filePath', 'target_file']) {
    if (typeof input[key] === 'string' && input[key]) {
      return input[key];
    }
  }
  return call.title;
}

/**
 * Reports Grok tool calls: a `tool_call` starts an action under its native tool
 * name with its raw input, and a terminal `tool_call_update` settles it with its
 * native output. The announced toolset is reported too. A policy denial and an
 * ordinary tool error both arrive as `failed`; only the text tells them apart.
 */
export function observeGrokEvent(event: GrokStreamEvent, tracker: NativeActionTracker) {
  if (event.event === 'tools') {
    tracker.toolset(event.tools);
    return;
  }
  if (event.event !== 'tool_call' && event.event !== 'tool_update') {
    return;
  }
  const call = event.call;
  if (!tracker.has(call.toolCallId)) {
    startCall(call, tracker);
  }
  if (call.status === 'completed') {
    tracker.finish(call.toolCallId, {
      outcome: 'done',
      output: grokOutput(call) || 'done',
      error: false,
    });
  } else if (call.status === 'failed') {
    const detail = grokOutput(call);
    const refused = /denied by permission policy/i.test(detail);
    tracker.finish(call.toolCallId, {
      outcome: refused ? 'refused' : `failed: ${detail}`,
      output: detail || 'failed',
      error: true,
    });
  }
}

function startCall(call: GrokToolCall, tracker: NativeActionTracker) {
  const kind = (call.kind && kinds[call.kind]) || 'other';
  const changed = kind === 'edit' ? editedPath(call) : undefined;
  tracker.start(call.toolCallId, {
    kind,
    tool: call.toolName ?? 'tool',
    input: call.rawInput,
    description: call.title ?? call.toolName ?? 'tool',
    ...(changed ? { changed } : {}),
  });
}

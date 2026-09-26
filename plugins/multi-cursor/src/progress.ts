import type { InteractionUpdate } from '@cursor/sdk';
import type { DerivedMirror } from '../../multi-core/src/gateway/display-rows.ts';
import type {
  NativeActionKind,
  NativeActionTracker,
} from '../../multi-core/src/gateway/harness-progress.ts';

type ToolCall = Extract<InteractionUpdate, { type: 'tool-call-started' }>['toolCall'];
type Success = Extract<NonNullable<ToolCall['result']>, { status: 'success' }>['value'];

/**
 * The tool-call types the Cursor SDK (1.0.31) reports, which are its native tool
 * names. The mod registers a display row for each at session start.
 */
export const CURSOR_TOOLS: readonly string[] = [
  'shell',
  'write',
  'delete',
  'glob',
  'grep',
  'read',
  'edit',
  'ls',
  'readLints',
  'mcp',
  'semSearch',
  'generateImage',
  'createPlan',
  'recordScreen',
  'updateTodos',
  'task',
];

const escapeCharacter = String.fromCharCode(27);
const bell = String.fromCharCode(7);
const terminalSequence = new RegExp(
  `${escapeCharacter}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${escapeCharacter}${bell}]*(?:${bell}|${escapeCharacter}\\\\))`,
  'g',
);
const maximumListed = 200;

function oneLine(value: string) {
  return value
    .replaceAll(terminalSequence, '')
    .replaceAll(/[\p{Cc}]/gu, ' ')
    .replaceAll(/[\p{Cf}]/gu, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function toolSummary(toolCall: ToolCall) {
  if (toolCall.type === 'shell') {
    return `Shell: ${oneLine(toolCall.args.command)}`;
  }
  if ('path' in toolCall.args && typeof toolCall.args.path === 'string') {
    return `${toolCall.type}: ${oneLine(toolCall.args.path)}`;
  }
  if (toolCall.type === 'mcp' && toolCall.args.toolName) {
    return `MCP: ${oneLine(toolCall.args.toolName)}`;
  }
  return toolCall.type;
}

const categories: Record<string, NativeActionKind> = {
  read: 'read',
  ls: 'read',
  grep: 'search',
  glob: 'search',
  semSearch: 'search',
  edit: 'edit',
  write: 'edit',
  delete: 'edit',
  shell: 'shell',
};

function failed(toolCall: ToolCall) {
  return (
    toolCall.result?.status === 'error' ||
    (toolCall.type === 'shell' &&
      toolCall.result?.status === 'success' &&
      toolCall.result.value.exitCode !== 0)
  );
}

/** One terse outcome for the summary and the status line. */
function outcome(toolCall: ToolCall) {
  if (!toolCall.result) {
    return 'ended without a reported outcome';
  }
  if (toolCall.result.status !== 'success') {
    const error = typeof toolCall.result.error === 'string' ? toolCall.result.error : '';
    return /denied|blocked|rejected/i.test(error) ? 'denied' : 'failed';
  }
  if (toolCall.type === 'shell') {
    const { exitCode, executionTime } = toolCall.result.value;
    const elapsed =
      Number.isFinite(executionTime) && executionTime >= 0
        ? ` · ${Math.round(executionTime)} ms`
        : '';
    return `exit ${exitCode}${elapsed}`;
  }
  if (toolCall.type === 'edit') {
    return editCounts(toolCall.result.value);
  }
  return 'done';
}

function editCounts(value: { linesAdded?: number; linesRemoved?: number }) {
  const counts = [
    typeof value.linesAdded === 'number' ? `+${value.linesAdded}` : '',
    typeof value.linesRemoved === 'number' ? `-${value.linesRemoved}` : '',
  ].filter(Boolean);
  return counts.length ? `${counts.join(' ')} lines` : 'done';
}

function listed(items: readonly string[], total: number) {
  const shown = items.slice(0, maximumListed);
  const more = total > shown.length ? `\n… ${total - shown.length} more` : '';
  return `${shown.join('\n')}${more}`;
}

/** Grep's native result: matching lines, file names or counts, per searched root. */
function grepOutput(value: Extract<ToolCall, { type: 'grep' }>['result']) {
  if (value?.status !== 'success') {
    return '';
  }
  const results = [
    ...Object.values(value.value.workspaceResults ?? {}),
    ...(value.value.activeEditorResult ? [value.value.activeEditorResult] : []),
  ];
  const lines = results.flatMap((result) => {
    if (result.type === 'content') {
      return result.output.matches.map(
        (match) => `${match.file}:${match.lineNumber ?? ''}:${match.line}`,
      );
    }
    if (result.type === 'files') {
      return result.output.files;
    }
    return result.output.counts.map((count) => `${count.file}:${count.count}`);
  });
  return listed(lines, lines.length);
}

type LsDirectoryTreeNode = Extract<
  Extract<ToolCall, { type: 'ls' }>['result'],
  { status: 'success' }
>['value']['directoryTreeRoot'];

function lsDirectoryPath(absPath: string) {
  return absPath.endsWith('/') ? absPath : `${absPath}/`;
}

function lsChildPath(parent: string, name: string) {
  const base = parent.endsWith('/') ? parent.slice(0, -1) : parent;
  return `${base}/${name}`;
}

/** `LsSuccess` (`directoryTreeRoot`: `LsDirectoryTreeNode`): one path per immediate child. */
function lsOutput(value: { directoryTreeRoot: LsDirectoryTreeNode }) {
  const root = value.directoryTreeRoot;
  const paths = [
    ...root.childrenDirs.map((dir) => lsDirectoryPath(dir.absPath)),
    ...root.childrenFiles.map((file) => lsChildPath(root.absPath, file.name)),
  ];
  return listed(paths, paths.length);
}

/** The native result as text, per tool; anything unmodelled is its JSON. */
function successOutput(toolCall: ToolCall, value: Success): string {
  switch (toolCall.type) {
    case 'shell': {
      const shell = value as { stdout: string; stderr: string; exitCode: number };
      return [shell.stdout, shell.stderr, `exit ${shell.exitCode}`].filter(Boolean).join('\n');
    }
    case 'read':
      return (value as { content: string }).content;
    case 'edit': {
      const edit = value as { diffString?: string; linesAdded?: number; linesRemoved?: number };
      return edit.diffString || editCounts(edit);
    }
    case 'write': {
      const written = value as { path: string; linesCreated: number };
      return `Wrote ${written.linesCreated} lines to ${written.path}`;
    }
    case 'delete':
      return `Deleted ${toolCall.args.path}`;
    case 'glob': {
      const found = value as { files: string[]; totalFiles: number };
      return listed(found.files, found.totalFiles);
    }
    case 'grep':
      return grepOutput(toolCall.result);
    case 'ls':
      return lsOutput(value as { directoryTreeRoot: LsDirectoryTreeNode });
    default:
      return JSON.stringify(value);
  }
}

/** The native output a completed call's row shows. */
function output(toolCall: ToolCall): string {
  const result = toolCall.result;
  if (!result) {
    return 'Cursor reported no result for this call.';
  }
  if (result.status !== 'success') {
    return typeof result.error === 'string' && result.error
      ? result.error
      : (JSON.stringify(result.error) ?? 'failed');
  }
  return successOutput(toolCall, result.value) || 'done';
}

type DiffSides = { before: string[]; after: string[] };

/** One line of a hunk body, added to the side(s) it belongs to. */
function addHunkLine(hunk: DiffSides, line: string) {
  const mark = line[0] ?? ' ';
  if (mark === '\\') {
    return; // `\ No newline at end of file`
  }
  if (mark !== '+') {
    hunk.before.push(line.slice(1));
  }
  if (mark !== '-') {
    hunk.after.push(line.slice(1));
  }
}

/** A unified diff's hunks, and whether its old side is `/dev/null` (a new file). */
function diffHunks(diff: string) {
  const hunks: DiffSides[] = [];
  let created = false;
  for (const line of diff.split('\n')) {
    const hunk = hunks.at(-1);
    if (line.startsWith('@@')) {
      hunks.push({ before: [], after: [] });
    } else if (hunk) {
      addHunkLine(hunk, line);
    } else if (line === '--- /dev/null') {
      created = true;
    }
  }
  return { hunks, created };
}

/**
 * Row fields from an `edit` result (`EditSuccess`: `linesAdded`, `linesRemoved`,
 * `diffString`, in `@cursor/sdk` `vendor/cursor-sdk-shared/tool-call-types.d.ts`).
 * Its args hold only `path`; its `diffString` is a unified diff (`--- /dev/null`
 * for a file it created, since `EditSuccess` exposes no created flag). A created
 * file is a Write row with the added lines as `content`; any other edit is an
 * Edit row with each hunk's old and new side as `old_string`/`new_string`.
 */
export function cursorEditMirror(toolCall: ToolCall): DerivedMirror | undefined {
  if (toolCall.type !== 'edit' || toolCall.result?.status !== 'success') {
    return undefined;
  }
  const diff = toolCall.result.value.diffString;
  if (!diff) {
    return undefined;
  }
  const { hunks, created } = diffHunks(diff);
  const side = (key: keyof DiffSides) => hunks.map((hunk) => hunk[key].join('\n')).join('\n');
  if (created) {
    return { kind: 'Write', fields: { content: side('after') } };
  }
  return hunks.length
    ? { fields: { old_string: side('before'), new_string: side('after') } }
    : undefined;
}

/**
 * Reports Cursor SDK tool calls: a start under the native tool name with its
 * native arguments, and a completion with its native output. Nothing here can
 * execute or replay the call.
 */
export function observeCursorUpdate(update: InteractionUpdate, tracker: NativeActionTracker) {
  if (update.type === 'tool-call-started') {
    const tool = update.toolCall;
    const path = 'path' in tool.args && typeof tool.args.path === 'string' ? tool.args.path : '';
    tracker.start(update.callId, {
      kind: categories[tool.type] ?? 'other',
      tool: tool.type,
      input: tool.args,
      description: toolSummary(tool),
      ...(path ? { changed: path } : {}),
    });
    return;
  }
  if (update.type !== 'tool-call-completed') {
    return;
  }
  const tool = update.toolCall;
  if (!tracker.has(update.callId)) {
    observeCursorUpdate({ ...update, type: 'tool-call-started' }, tracker);
  }
  tracker.finish(update.callId, {
    outcome: oneLine(outcome(tool)),
    output: output(tool),
    error: failed(tool),
    ...optionalMirror(tool),
  });
}

function optionalMirror(tool: ToolCall) {
  const mirror = cursorEditMirror(tool);
  return mirror ? { mirror } : {};
}

/** Native context compaction is the one mid-run notice kept in the transcript. */
export function cursorContextNotice(update: InteractionUpdate): string | undefined {
  if (update.type === 'summary-started') {
    return '[Cursor] Compacting context…';
  }
  if (update.type === 'summary-completed') {
    return '[Cursor] Context compacted.';
  }
  return undefined;
}

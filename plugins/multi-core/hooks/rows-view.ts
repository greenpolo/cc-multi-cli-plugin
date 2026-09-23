import type { ElementTable, RenderElement } from 'claude-code';

/**
 * The drawing of a native harness action's row, as Claude Code draws the
 * built-in tool the action mirrors (`kind`, set by the gateway's `mirroredInput`).
 *
 * The engine draws a registered tool as `probe - view_file (MCP)(file_path: "a")`
 * and would draw a mirrored input the same way, so the header and the summary
 * results are built here, cell for cell after the built-ins as this build draws
 * them in the terminal: a `●` in the theme's `success` (or `error`) colour (`inactive`
 * for an action the native run never confirmed), the
 * bold tool name, the argument in parentheses in the text colour, and under it
 * `  ⎿  ` in `inactive` with the result beside it. Only the name differs: the
 * native tool's (`view_file`), not the built-in's (`Read`).
 */
type Kind = 'Read' | 'Bash' | 'Grep' | 'Glob' | 'LS' | 'Edit' | 'Write';
type Tags = Pick<ElementTable, 'Box' | 'Text'>;
type Input = Record<string, unknown>;
type Part = string | { bold: string };
type DiffLine = { mark: ' ' | '-' | '+'; text: string; number?: number };
type Hunk = { old: number; new: number };

const kinds = new Set<string>(['Read', 'Bash', 'Grep', 'Glob', 'LS', 'Edit', 'Write']);
const argumentLength = 160;
const previewLines = 10;
const diffLines = 40;
const errorLines = 10;
const tokenKey = 'multi_row';
const summaryKeys: readonly RegExp[] = [
  /^command(line)?$|^cmd$/i,
  /path|file|directory|^dir$/i,
  /pattern|query|glob|url|search/i,
];

function mirroredKind(input: Input | undefined): Kind | undefined {
  const kind = input?.kind;
  return typeof kind === 'string' && kinds.has(kind) ? (kind as Kind) : undefined;
}

function text(input: Input, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function count(value: number, unit: string): Part[] {
  return [{ bold: String(value) }, ` ${unit}${value === 1 ? '' : 's'}`];
}

function oneLine(value: string) {
  const line = value.replaceAll(/\s+/g, ' ').trim();
  return line.length > argumentLength ? `${line.slice(0, argumentLength)}…` : line;
}

/** A path as the built-ins show it: relative to the session's directory when inside it. */
function shownPath(path: string, cwd: string): string {
  if (cwd && path === cwd) {
    return '.';
  }
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return cwd && path.startsWith(root) ? path.slice(root.length) : path;
}

function readRange(input: Input) {
  const offset = typeof input.offset === 'number' ? input.offset : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : undefined;
  if (limit !== undefined) {
    const start = offset ?? 1;
    return ` · lines ${start}-${start + limit - 1}`;
  }
  return offset === undefined ? '' : ` · from line ${offset}`;
}

function quoted(input: Input, keys: readonly string[], cwd: string) {
  return keys
    .filter((key) => text(input, key))
    .map((key) => {
      const value = text(input, key);
      return `${key}: "${oneLine(key === 'path' ? shownPath(value, cwd) : value)}"`;
    })
    .join(', ');
}

/** The argument a built-in shows in its header: `Read(src/a.ts)`, `Bash(echo hi)`, ... */
export function headerSummary(input: Input, cwd: string): string {
  switch (mirroredKind(input)) {
    case 'Read':
      return `${shownPath(text(input, 'file_path'), cwd)}${readRange(input)}`;
    case 'Bash':
      return oneLine(text(input, 'command'));
    case 'Grep':
      return quoted(input, ['pattern', 'path', 'glob'], cwd);
    case 'Glob':
      return quoted(input, ['pattern', 'path'], cwd);
    case 'LS':
      return shownPath(text(input, 'path'), cwd);
    case 'Edit':
    case 'Write':
      return shownPath(text(input, 'file_path'), cwd);
    default:
      return argumentSummary(input.native ?? input);
  }
}

/** The native path, command or pattern of an input with no mirrored built-in, on one line. */
function argumentSummary(input: unknown): string {
  const values = Object.entries(record(input) ?? {}).filter(
    (entry): entry is [string, string] =>
      entry[0] !== tokenKey && typeof entry[1] === 'string' && entry[1].trim() !== '',
  );
  for (const pattern of summaryKeys) {
    const found = values.find(([key]) => pattern.test(key));
    if (found) {
      return oneLine(found[1]);
    }
  }
  return values.length ? oneLine(values[0]?.[1] ?? '') : '';
}

/** `● name(argument)`, as the transcript draws a built-in tool's call. */
export function toolHeader(
  { Box, Text }: Tags,
  row: { name: string; summary: string; color: string },
): RenderElement {
  return Box({
    flexDirection: 'row',
    children: [
      Box({ minWidth: 2, children: Text({ color: row.color, children: '●' }) }),
      Text({ bold: true, children: row.name }),
      ...(row.summary ? [Text({ children: `(${row.summary})` })] : []),
    ],
  });
}

/**
 * `  ⎿ ` and a no-break space (as the engine draws it) with the result beside it,
 * continuation lines under the result.
 */
export function response({ Box, Text }: Tags, lines: RenderElement[]): RenderElement {
  return Box({
    flexDirection: 'row',
    children: [
      Box({ minWidth: 5, children: Text({ color: 'inactive', children: '  ⎿ \u00a0' }) }),
      Box({ flexDirection: 'column', flexGrow: 1, children: lines }),
    ],
  });
}

function sentence({ Text }: Tags, parts: readonly Part[]): RenderElement {
  return Text({
    children: parts.map((part) =>
      typeof part === 'string' ? part : Text({ bold: true, children: part.bold }),
    ),
  });
}

function more({ Text }: Tags, hidden: number): RenderElement[] {
  return hidden > 0 ? [Text({ dimColor: true, children: `… +${hidden} lines` })] : [];
}

/** A text's lines, without the empty one after a final newline. */
function textLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') {
    lines.pop();
  }
  return value === '' ? [] : lines;
}

/** How many lines a read returned: `agy` reports `2 lines, 6 bytes`, Cursor the content. */
function readCount(output: string): number {
  const reported = /^(\d+) lines?\b/.exec(output.trim());
  return reported ? Number(reported[1]) : textLines(output).length;
}

/** How many results a search listed, a trailing `… N more` counted in. */
function foundCount(output: string): number {
  if (/^no (results|matches|files)\b/i.test(output.trim())) {
    return 0;
  }
  const lines = textLines(output).filter((line) => line.trim() !== '');
  const hidden = /^… (\d+) more$/.exec(lines.at(-1) ?? '');
  return hidden ? lines.length - 1 + Number(hidden[1]) : lines.length;
}

function numbered(tags: Tags, number: string, line: string): RenderElement {
  const { Box, Text } = tags;
  return Box({
    flexDirection: 'row',
    children: [Text({ dimColor: true, children: `${number} ` }), Text({ children: line })],
  });
}

function writeBody(tags: Tags, input: Input, cwd: string): RenderElement[] {
  const lines = textLines(text(input, 'content'));
  const width = String(lines.length).length + 1;
  const shown = lines.slice(0, previewLines);
  return [
    sentence(tags, [
      'Wrote ',
      ...count(lines.length, 'line'),
      ' to ',
      { bold: shownPath(text(input, 'file_path'), cwd) },
    ]),
    ...shown.map((line, index) => numbered(tags, String(index + 1).padStart(width), line)),
    ...more(tags, lines.length - shown.length),
  ];
}

function hunkStart(line: string): Hunk | undefined {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return match ? { old: Number(match[1]), new: Number(match[2]) } : undefined;
}

function hunkLine(line: string, at: Hunk): DiffLine | undefined {
  const mark = line[0] ?? ' ';
  if (mark === '-') {
    return { mark, text: line.slice(1), number: at.old++ };
  }
  if (mark === '+') {
    return { mark, text: line.slice(1), number: at.new++ };
  }
  if (mark !== ' ' && line !== '') {
    return undefined;
  }
  at.old++;
  return { mark: ' ', text: line.slice(1), number: at.new++ };
}

/** The lines of a unified diff's hunks, numbered as the file's lines; undefined without one. */
function unifiedDiff(value: string): DiffLine[] | undefined {
  const lines: DiffLine[] = [];
  let at: Hunk | undefined;
  for (const line of textLines(value)) {
    const start = hunkStart(line);
    if (start) {
      at = start;
    } else if (at) {
      const parsed = hunkLine(line, at);
      if (parsed) {
        lines.push(parsed);
      }
    }
  }
  return at ? lines : undefined;
}

function pairDiff(input: Input): DiffLine[] {
  const start = typeof input.offset === 'number' ? input.offset : undefined;
  const side = (key: string, mark: '-' | '+'): DiffLine[] =>
    textLines(text(input, key)).map((line, index) => ({
      mark,
      text: line,
      ...(start === undefined ? {} : { number: start + index }),
    }));
  return [...side('old_string', '-'), ...side('new_string', '+')];
}

function diffRow(tags: Tags, line: DiffLine, width: number): RenderElement {
  const { Box, Text } = tags;
  const number = width ? `${String(line.number ?? '').padStart(width)} ` : '';
  if (line.mark === ' ') {
    return numbered(tags, number.trimEnd(), ` ${line.text}`);
  }
  const background = line.mark === '-' ? 'diffRemoved' : 'diffAdded';
  return Box({
    flexDirection: 'row',
    children: [
      Text({
        backgroundColor: background,
        color: line.mark === '-' ? 'diffRemovedWord' : 'diffAddedWord',
        children: `${number}${line.mark}`,
      }),
      Text({ backgroundColor: background, color: 'text', children: line.text }),
    ],
  });
}

function editSummary(added: number, removed: number): Part[] {
  const parts: Part[] = added ? ['Added ', ...count(added, 'line')] : [];
  if (removed) {
    parts.push(added ? ', removed ' : 'Removed ', ...count(removed, 'line'));
  }
  return parts;
}

/**
 * The counts an edit reported without a diff (Cursor's `+1 -1 lines` when its
 * result carries `linesAdded`/`linesRemoved` and no `diffString`).
 */
function reportedCounts(output: string) {
  const match = /^(?:\+(\d+))? ?(?:-(\d+))? lines$/.exec(output.trim());
  return match ? { added: Number(match[1] ?? 0), removed: Number(match[2] ?? 0) } : undefined;
}

function editBody(tags: Tags, input: Input, output: string): RenderElement[] | undefined {
  const lines = unifiedDiff(output) ?? pairDiff(input);
  const counted = lines.length ? undefined : reportedCounts(output);
  const summary = counted
    ? editSummary(counted.added, counted.removed)
    : editSummary(
        lines.filter((line) => line.mark === '+').length,
        lines.filter((line) => line.mark === '-').length,
      );
  if (!summary.length) {
    return undefined;
  }
  const numbers = lines.map((line) => line.number ?? 0);
  const width = numbers.some(Boolean) ? String(Math.max(...numbers)).length + 1 : 0;
  const shown = lines.slice(0, diffLines);
  return [
    sentence(tags, summary),
    ...shown.map((line) => diffRow(tags, line, width)),
    ...more(tags, lines.length - shown.length),
  ];
}

function searchUnit(output: string) {
  return textLines(output).some((line) => /^[^:\n]+:\d+:/.test(line)) ? 'line' : 'file';
}

/**
 * The result lines of a successful mirrored row, as its built-in draws them in
 * both the compact and the ctrl+o view (`Read 40 lines`, `Found 3 files`, a
 * write's preview, an edit's diff); undefined where the built-in shows the output
 * itself, which the engine then draws with its own compact and ctrl+o forms.
 */
export function resultBody(
  tags: Tags,
  input: Input,
  output: string,
  cwd: string,
): RenderElement[] | undefined {
  switch (mirroredKind(input)) {
    case 'Read':
      return [sentence(tags, ['Read ', ...count(readCount(output), 'line')])];
    case 'Grep':
      return [sentence(tags, ['Found ', ...count(foundCount(output), searchUnit(output))])];
    case 'Glob':
      return [sentence(tags, ['Found ', ...count(foundCount(output), 'file')])];
    case 'LS':
      return [sentence(tags, ['Listed ', ...count(foundCount(output), 'path')])];
    case 'Write':
      return text(input, 'content') ? writeBody(tags, input, cwd) : undefined;
    case 'Edit':
      return editBody(tags, input, output);
    default:
      return undefined;
  }
}

/** A failed action's result: `Error: ...` in the theme's error colour, as the built-ins. */
export function errorBody(tags: Tags, output: string): RenderElement[] {
  const lines = textLines(/^error\b/i.test(output) ? output : `Error: ${output}`);
  const shown = lines.slice(0, errorLines);
  return [
    ...shown.map((line) => tags.Text({ color: 'error', children: line })),
    ...more(tags, lines.length - shown.length),
  ];
}

/**
 * An action the native run never confirmed: neither a success nor a failure, so
 * it is drawn in the theme's `inactive` tone and says so.
 */
export function unconfirmedBody(tags: Tags, output: string): RenderElement[] {
  const detail = output.trim() || 'the native run reported no completion for this action.';
  const lines = textLines(`Unconfirmed: ${detail.charAt(0).toLowerCase()}${detail.slice(1)}`);
  const shown = lines.slice(0, errorLines);
  return [
    ...shown.map((line) => tags.Text({ color: 'inactive', children: line })),
    ...more(tags, lines.length - shown.length),
  ];
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

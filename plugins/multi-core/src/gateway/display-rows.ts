import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ContentBlock,
  MessagesRequest,
  MessagesResponse,
  RequestMessage,
} from './messages.ts';

/**
 * Native harness actions drawn as Claude Code tool rows.
 *
 * Cursor, Antigravity and Grok run their own tools. A row inside a Claude Code
 * session exists only for a tool_use block in that session's transcript, so the
 * gateway writes one per finished native action into the harness's own reply,
 * named after the harness's real tool (`mcp__multi-core__run_command`). Its input
 * mirrors the equivalent Claude Code built-in (`kind: "Bash"` with `command`, see
 * `mirroredInput`) so the mod draws the row as that built-in draws its own, and
 * keeps the native parameters under `native`. The Multi mod registers those names with
 * `$.tool.register`, and its `tool.call` answers each row with the native output
 * it fetches from the gateway by the row's one-time token.
 *
 * These are display tools, never model tools: the gateway strips them from every
 * forwarded `tools` list and every forwarded history, the mod defers them behind
 * ToolSearch, and the mod's `tool.check` denies any call the gateway did not
 * originate, which is any call without a token this gateway issued.
 */
const DISPLAY_TOOL_PREFIX = 'mcp__multi-core__';
/** A worker definition's grant for every display tool; it grants no native capability. */
export const DISPLAY_TOOL_SERVER = 'mcp__multi-core';
/** The input key carrying the gateway-issued token. */
export const ROW_TOKEN = 'multi_row';

// A tool name is at most 64 characters, prefix included.
const maximumName = 64 - DISPLAY_TOOL_PREFIX.length;
const maximumTools = 160;
const maximumRows = 2048;
const maximumFollowUps = 2048;
const maximumOutput = 16 * 1024;
const maximumInputValue = 2000;
const maximumInputKeys = 32;
const namePattern = /^[A-Za-z0-9_-]+$/;
/**
 * The id of a row this gateway wrote. A provider mints the ids of its own tool
 * calls, so a model can name a display tool but never give its call this id.
 */
const issuedId = /^toolu_multi_[a-f0-9]{32}$/;
const reminderOnly = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*)*$/;

/**
 * The follow-up text when a reply deferred none; a turn's last message must say
 * something, or the engine asks the model again for visible output.
 */
export const followUpFallback = 'Native run finished.';

/**
 * Row fields a harness derives from an action's result rather than its
 * parameters: Cursor's `edit` takes only a path and reports its change as a
 * unified diff, so its row's `old_string`/`new_string` come from the result, and
 * a diff from `/dev/null` is a file creation, drawn as `kind: "Write"`.
 */
export type DerivedMirror = { kind?: MirroredKind; fields: Record<string, string> };

/**
 * One finished native action, as a harness reports it. `unconfirmed` marks an
 * action whose completion never arrived: neither a success nor a failure.
 */
export type NativeRow = {
  tool: string;
  input: unknown;
  output: string;
  error: boolean;
  unconfirmed?: boolean;
  mirror?: DerivedMirror;
};

export type DisplayToolUse = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type IssuedRow = { session: string; id: string; output: string; isError: boolean };
/**
 * A reply's deferred text and the context its rows were written over: the
 * follow-up is the turn's last response, which Claude Code reads the window's fill from.
 */
type FollowUp = { text: string; usage?: MessagesResponse['usage'] };
/** The session, worker and provider a reply with rows was written for. */
export type FollowUpOwner = { scope: string; provider: string };
/** A reply's deferred text, bound to its owner and to the rows that reply wrote. */
type PendingFollowUp = FollowUp & {
  owner: FollowUpOwner;
  session: string;
  response: string;
  rows: ReadonlySet<string>;
};

/** A follow-up request names rows another session, worker or provider's reply wrote. */
export class FollowUpRefused extends Error {}
/** Neither the gateway nor the harness record holds the reply those rows belong to. */
export class FollowUpUnavailable extends Error {}

const refusedFollowUp =
  "Display row results belong to another session or worker's reply; its answer is not returned here.";
export const unavailableFollowUp =
  'The answer of the reply these display rows belong to is no longer available (the gateway ' +
  'restarted or the reply was replaced, and no native session record holds it). Submit a new prompt.';

/** The short display name for a native tool, or undefined when it cannot be one. */
function displayName(native: unknown): string | undefined {
  return typeof native === 'string' && native.length <= maximumName && namePattern.test(native)
    ? native
    : undefined;
}

export function isDisplayTool(name: unknown): boolean {
  return typeof name === 'string' && name.startsWith(DISPLAY_TOOL_PREFIX);
}

/** Tool rules naming display tools restrict nothing native; mappers drop them. */
export function nativeToolRules(rules: string[] | undefined): string[] | undefined {
  return rules?.filter((rule) => rule !== DISPLAY_TOOL_SERVER && !isDisplayTool(rule));
}

function bounded(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return input === undefined ? {} : { value: input };
}

/** The Claude Code built-in a native tool mirrors, and where its fields come from. */
type MirroredKind = 'Read' | 'Bash' | 'Grep' | 'Glob' | 'LS' | 'Edit' | 'Write';
type Mirror = { kind: MirroredKind; fields: Record<string, readonly string[]> };

const pathKeys = ['file_path', 'filePath', 'path', 'AbsolutePath', 'TargetFile', 'target_file'];
const directoryKeys = [
  'path',
  'targetDirectory',
  'target_directory',
  'SearchDirectory',
  'SearchPath',
  'DirectoryPath',
  'directory',
];
const read: Mirror = { kind: 'Read', fields: { file_path: pathKeys } };
const bash: Mirror = {
  kind: 'Bash',
  fields: { command: ['command', 'CommandLine', 'cmd'], description: ['description'] },
};
const grep: Mirror = {
  kind: 'Grep',
  fields: {
    pattern: ['pattern', 'Query', 'query', 'regex'],
    path: directoryKeys,
    glob: ['glob', 'Includes', 'include', 'include_pattern'],
  },
};
const glob: Mirror = {
  kind: 'Glob',
  fields: { pattern: ['globPattern', 'pattern', 'Pattern', 'glob_pattern'], path: directoryKeys },
};
const list: Mirror = {
  kind: 'LS',
  fields: { path: [...directoryKeys, 'relative_workspace_path'] },
};
const edit: Mirror = {
  kind: 'Edit',
  fields: {
    file_path: pathKeys,
    old_string: ['old_string', 'TargetContent', 'old_str', 'oldText'],
    new_string: ['new_string', 'ReplacementContent', 'new_str', 'newText'],
  },
};
const write: Mirror = {
  kind: 'Write',
  fields: { file_path: pathKeys, content: ['content', 'CodeContent', 'fileText', 'file_text'] },
};

/**
 * Native tools of Cursor (`CURSOR_TOOLS`), Antigravity (`ANTIGRAVITY_TOOLS`) and
 * Grok (its announced toolset) by the Claude Code built-in each one's row draws as.
 */
const mirrors: Readonly<Record<string, Mirror>> = {
  view_file: read,
  read: read,
  read_file: read,
  run_command: bash,
  shell: bash,
  run_terminal_command: bash,
  run_terminal_cmd: bash,
  grep_search: grep,
  grep: grep,
  find_by_name: glob,
  glob: glob,
  list_dir: list,
  ls: list,
  replace_file_content: edit,
  multi_replace_file_content: edit,
  edit: edit,
  search_replace: edit,
  write_to_file: write,
  write: write,
};
const kindMirrors: Readonly<Record<MirroredKind, Mirror>> = {
  Read: read,
  Bash: bash,
  Grep: grep,
  Glob: glob,
  LS: list,
  Edit: edit,
  Write: write,
};
/** Fields whose whole text a row draws (a written file, an edit's two sides). */
const bodyFields = new Set(['content', 'old_string', 'new_string']);

/**
 * A string (or a list of strings, comma-joined) under one of `keys`, any case;
 * an empty string only when `empty` (an edit's new side may be nothing).
 */
function nativeString(input: Record<string, unknown>, keys: readonly string[], empty = false) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(input)) {
    if (!wanted.has(key.toLowerCase())) {
      continue;
    }
    if (typeof value === 'string' && (empty || value !== '')) {
      return value;
    }
    if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string')) {
      return value.join(',');
    }
  }
  return undefined;
}

function nativeNumber(input: Record<string, unknown>, keys: readonly string[]) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const found = Object.entries(input).find(
    ([key, value]) =>
      wanted.has(key.toLowerCase()) && typeof value === 'number' && Number.isInteger(value),
  );
  return found ? (found[1] as number) : undefined;
}

/** Read's `offset`/`limit`, from a native start and end line when that is what it gives. */
function readRange(input: Record<string, unknown>) {
  const offset = nativeNumber(input, ['offset', 'StartLine', 'start_line']);
  const end = nativeNumber(input, ['EndLine', 'end_line']);
  const limit =
    nativeNumber(input, ['limit']) ??
    (offset !== undefined && end !== undefined && end >= offset ? end - offset + 1 : undefined);
  return {
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** An edit given as several replacement chunks (`multi_replace_file_content`), as one pair. */
function chunkPair(input: Record<string, unknown>) {
  const chunks = Object.entries(input).find(
    ([key, value]) => /chunks$/i.test(key) && Array.isArray(value),
  )?.[1] as unknown[] | undefined;
  const pairs = (chunks ?? []).map(inputRecord);
  if (!pairs.length) {
    return {};
  }
  const side = (keys: readonly string[]) =>
    pairs.map((pair) => nativeString(pair, keys) ?? '').join('\n');
  return {
    old_string: side(edit.fields.old_string ?? []),
    new_string: side(edit.fields.new_string ?? []),
  };
}

/** A derived field, bounded as the native field of that name would be. */
function derivedFields(derived: DerivedMirror | undefined) {
  const fields: Record<string, string> = {};
  for (const [field, value] of Object.entries(derived?.fields ?? {})) {
    fields[field] = bounded(value, bodyFields.has(field) ? maximumOutput : maximumInputValue);
  }
  return fields;
}

/**
 * The row input for a native action: the fields of the Claude Code built-in it
 * mirrors (`kind`), under that built-in's names, beside the native parameters.
 * Fields `derived` from the result (and its `kind`, when it names another
 * built-in) take precedence. A tool without an equivalent carries its native
 * parameters alone.
 */
export function mirroredInput(
  tool: string,
  input: unknown,
  derived?: DerivedMirror,
): Record<string, unknown> {
  const native = boundedInput(input);
  const byTool = Object.hasOwn(mirrors, tool) ? mirrors[tool] : undefined;
  const mirror = derived?.kind ? kindMirrors[derived.kind] : byTool;
  if (!mirror) {
    return { native };
  }
  const source = inputRecord(input);
  const fields: Record<string, unknown> = {
    ...(mirror.kind === 'Edit' ? chunkPair(source) : {}),
    ...(mirror.kind === 'Read' ? readRange(source) : {}),
  };
  for (const [field, keys] of Object.entries(mirror.fields)) {
    const body = bodyFields.has(field);
    const value = nativeString(source, keys, body);
    if (value !== undefined) {
      fields[field] = bounded(value, body ? maximumOutput : maximumInputValue);
    }
  }
  return { kind: mirror.kind, ...fields, ...derivedFields(derived), native };
}

/** Native parameters, bounded: long strings and nested values are cut, never dropped silently. */
function boundedInput(input: unknown): Record<string, unknown> {
  const record = inputRecord(input);
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record).slice(0, maximumInputKeys)) {
    if (key === ROW_TOKEN) {
      continue;
    }
    if (typeof value === 'string') {
      output[key] = bounded(value, maximumInputValue);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      output[key] = value;
    } else if (value !== undefined) {
      const json = JSON.stringify(value) ?? '';
      output[key] = json.length > maximumInputValue ? bounded(json, maximumInputValue) : value;
    }
  }
  return output;
}

function remember<T>(map: Map<string, T>, key: string, value: T, capacity: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > capacity) {
    map.delete(map.keys().next().value as string);
  }
}

/**
 * The gateway's side of display rows: the native tool names offered to the mod,
 * the names it acknowledged registering, the tokens it issued, and the text each
 * reply defers to the turn that answers its rows.
 */
export class DisplayRows {
  private readonly known = new Set<string>();
  private readonly registered = new Set<string>();
  private readonly rows = new Map<string, IssuedRow>();
  /** The pending reply of each scope, and which scope wrote each of its rows. */
  private readonly followUps = new Map<string, PendingFollowUp>();
  private readonly rowOwners = new Map<string, string>();
  private revision = 0;

  /** Offers native tool names to the mod; a name it cannot register is ignored. */
  announce(names: Iterable<unknown>) {
    for (const native of names) {
      const name = displayName(native);
      if (name && !this.known.has(name) && this.known.size < maximumTools) {
        this.known.add(name);
        this.revision++;
      }
    }
  }

  catalog() {
    return { revision: this.revision, names: [...this.known] };
  }

  /** Records names the mod registered; only those are ever emitted as rows. */
  acknowledge(names: unknown) {
    if (!Array.isArray(names)) {
      throw new Error('Invalid display tool acknowledgement');
    }
    for (const name of names) {
      if (typeof name === 'string' && this.known.has(name)) {
        this.registered.add(name);
      }
    }
    return { registered: this.registered.size };
  }

  /**
   * One tool_use block for a finished native action in the scope's session, or
   * undefined when the mod has not registered that tool (the action then stays
   * in the reply's summary only).
   */
  issue(scope: string, row: NativeRow): DisplayToolUse | undefined {
    const name = displayName(row.tool);
    if (!name || !this.registered.has(name)) {
      return undefined;
    }
    const id = `toolu_multi_${randomUUID().replaceAll('-', '')}`;
    const token = randomBytes(16).toString('hex');
    const session = String(JSON.parse(scope)[0]);
    remember(
      this.rows,
      token,
      { session, id, output: bounded(row.output, maximumOutput), isError: row.error },
      maximumRows,
    );
    return {
      type: 'tool_use',
      id,
      name: `${DISPLAY_TOOL_PREFIX}${name}`,
      input: {
        ...mirroredInput(name, row.input, row.mirror),
        ...(row.error ? { failed: true } : {}),
        ...(row.unconfirmed && !row.error ? { unconfirmed: true } : {}),
        [ROW_TOKEN]: token,
      },
    };
  }

  /** The native output a row carries, only for the token, call and session it was issued for. */
  verify(session: unknown, token: unknown, toolUseId: unknown) {
    const row = typeof token === 'string' ? this.rows.get(token) : undefined;
    if (!row || row.session !== session || row.id !== toolUseId) {
      return undefined;
    }
    return { output: row.output, isError: row.isError };
  }

  /**
   * Holds a reply's deferred text for the request that answers its rows. It is
   * the scope's pending reply, replacing the one before it, and only that scope
   * and provider may read it (see `followUp`).
   */
  rememberFollowUp(
    owner: FollowUpOwner,
    reply: { id: string; rows: readonly string[]; text: string; usage?: MessagesResponse['usage'] },
  ) {
    this.dropFollowUp(owner.scope);
    this.followUps.set(owner.scope, {
      owner: { ...owner },
      session: sessionOf(owner.scope),
      response: reply.id,
      rows: new Set(reply.rows),
      text: reply.text,
      ...(reply.usage ? { usage: reply.usage } : {}),
    });
    for (const id of reply.rows) {
      this.rowOwners.set(id, owner.scope);
    }
    while (this.followUps.size > maximumFollowUps) {
      this.dropFollowUp(this.followUps.keys().next().value as string);
    }
  }

  /**
   * The pending reply every one of `ids` belongs to, for its own scope and
   * provider; undefined when this gateway holds none of them (a restart or an
   * eviction), so the caller can consult the harness record. Rows of another
   * scope, another provider, or of more than the pending reply are refused.
   */
  followUp(owner: FollowUpOwner, ids: readonly string[]): FollowUp | undefined {
    const scopes = ids.map((id) => this.rowOwners.get(id));
    if (scopes.every((scope) => scope === undefined)) {
      return undefined;
    }
    const pending = this.followUps.get(owner.scope);
    if (
      !pending ||
      pending.owner.provider !== owner.provider ||
      scopes.some((scope) => scope !== owner.scope) ||
      ids.some((id) => !pending.rows.has(id))
    ) {
      throw new FollowUpRefused(refusedFollowUp);
    }
    return { text: pending.text, ...(pending.usage ? { usage: pending.usage } : {}) };
  }

  private dropFollowUp(scope: string) {
    const pending = this.followUps.get(scope);
    if (!pending) {
      return;
    }
    this.followUps.delete(scope);
    for (const id of pending.rows) {
      if (this.rowOwners.get(id) === scope) {
        this.rowOwners.delete(id);
      }
    }
  }

  forgetSession(session: string) {
    for (const [token, row] of this.rows) {
      if (row.session === session) {
        this.rows.delete(token);
      }
    }
    for (const [scope, pending] of this.followUps) {
      if (pending.session === session) {
        this.dropFollowUp(scope);
      }
    }
  }
}

/** The session of a `[session, agent]` scope. */
function sessionOf(scope: string): string {
  try {
    const parsed: unknown = JSON.parse(scope);
    return Array.isArray(parsed) ? String(parsed[0]) : scope;
  } catch {
    return scope;
  }
}

/**
 * A reply's deferred text from a harness's durable record of it: only when that
 * reply wrote every one of `ids` and held text back. The record belongs to one
 * session and worker, so it answers only their own rows.
 */
export function recordedFollowUp(
  response: MessagesResponse | undefined,
  ids: readonly string[],
): FollowUp | undefined {
  if (!response || typeof response.multi_followup !== 'string' || !ids.length) {
    return undefined;
  }
  const rows = new Set(
    response.content.flatMap((block) =>
      block.type === 'tool_use' && isDisplayTool(block.name) ? [block.id] : [],
    ),
  );
  if (ids.some((id) => !rows.has(id))) {
    return undefined;
  }
  return { text: response.multi_followup, usage: response.usage };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Only a well-formed request is rewritten or answered here; anything else passes
 * unchanged to the validation that refuses it with the provider's own error.
 */
function wellFormed(body: MessagesRequest): boolean {
  const tools: unknown = body.tools;
  const messages: unknown = body.messages;
  return (
    (tools === undefined || (Array.isArray(tools) && tools.every(isObject))) &&
    (messages === undefined ||
      (Array.isArray(messages) &&
        messages.every(
          (message) =>
            isObject(message) &&
            typeof message.role === 'string' &&
            (typeof message.content === 'string' ||
              (Array.isArray(message.content) && message.content.every(isObject))),
        )))
  );
}

function blocks(message: RequestMessage | undefined): ContentBlock[] | undefined {
  return message && Array.isArray(message.content) ? message.content : undefined;
}

function displayIds(messages: readonly RequestMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    for (const block of blocks(message) ?? []) {
      if (
        block.type === 'tool_use' &&
        isDisplayTool(block.name) &&
        typeof block.id === 'string' &&
        issuedId.test(block.id)
      ) {
        ids.add(block.id);
      }
    }
  }
  return ids;
}

/**
 * The display row ids a request only answers: its last message holds nothing but
 * tool results for the display rows of the assistant message before it (and
 * system reminders or `system` turns). Such a request is the engine continuing after running rows;
 * the gateway answers it with the reply's deferred text, never a native run.
 */
export function displayFollowUp(body: MessagesRequest): string[] | undefined {
  if (!wellFormed(body)) {
    return undefined;
  }
  // Claude Code sends its environment and budget notes as `system` turns, even last.
  const turns = (body.messages ?? []).filter((message) => message.role !== 'system');
  const last = blocks(turns.at(-1));
  const previous = turns.at(-2);
  if (!last || turns.at(-1)?.role !== 'user' || previous?.role !== 'assistant') {
    return undefined;
  }
  const rows = displayIds([previous]);
  const results = last.filter((block) => block.type === 'tool_result');
  if (
    !rows.size ||
    !results.length ||
    results.some((block) => !rows.has(String(block.tool_use_id))) ||
    last.some(
      (block) =>
        block.type !== 'tool_result' &&
        !(block.type === 'text' && typeof block.text === 'string' && reminderOnly.test(block.text)),
    )
  ) {
    return undefined;
  }
  return results.map((block) => String(block.tool_use_id));
}

/**
 * A text block without the display tools Claude Code lists in its reminders: a
 * ToolSearch catalogue line naming one, and the grant in a worker's tool list.
 */
function scrubbed(block: ContentBlock): ContentBlock {
  if (
    block.type !== 'text' ||
    typeof block.text !== 'string' ||
    !block.text.includes(DISPLAY_TOOL_SERVER)
  ) {
    return block;
  }
  const text = block.text
    .split('\n')
    .filter((line) => !isDisplayTool(line.trim()) || /\s/.test(line.trim()))
    .join('\n')
    .replaceAll(`, ${DISPLAY_TOOL_SERVER})`, ')');
  return { ...block, text };
}

function withoutRows(message: RequestMessage, rows: ReadonlySet<string>): RequestMessage {
  const content = blocks(message);
  if (!content) {
    return message;
  }
  const kept = content
    .filter(
      (block) =>
        !(block.type === 'tool_use' && rows.has(String(block.id))) &&
        !(block.type === 'tool_result' && rows.has(String(block.tool_use_id))),
    )
    .map(scrubbed);
  return { ...message, content: kept };
}

function asBlocks(content: RequestMessage['content']): ContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

/** Removal can leave empty turns and two turns of one role in a row; both are closed up. */
function closedUp(messages: RequestMessage[]): RequestMessage[] {
  const result: RequestMessage[] = [];
  for (const message of messages) {
    if (Array.isArray(message.content) && !message.content.length) {
      continue;
    }
    const previous = result.at(-1);
    if (previous && previous.role === message.role) {
      result[result.length - 1] = {
        ...previous,
        content: [...asBlocks(previous.content), ...asBlocks(message.content)],
      };
    } else {
      result.push(message);
    }
  }
  return result;
}

/**
 * The request a provider may see: no display tool in `tools`, and no display row,
 * its result or its catalogue line in the history. A call a model made to a
 * display name (which the mod refused) stays, so the model sees the refusal. A
 * request without any is returned unchanged, so ordinary traffic keeps its bytes.
 */
export function withoutDisplayTools(body: MessagesRequest): MessagesRequest {
  if (!wellFormed(body)) {
    return body;
  }
  const tools = body.tools?.filter((tool) => !isDisplayTool(tool.name));
  const messages = body.messages ?? [];
  const serialized = JSON.stringify(messages);
  if (tools?.length === body.tools?.length && !serialized.includes(DISPLAY_TOOL_SERVER)) {
    return body;
  }
  const rows = displayIds(messages);
  const stripped = rows.size
    ? closedUp(messages.map((message) => withoutRows(message, rows)))
    : messages.map((message) => withoutRows(message, rows));
  return {
    ...body,
    ...(body.tools ? { tools } : {}),
    ...(body.messages ? { messages: stripped } : {}),
  };
}

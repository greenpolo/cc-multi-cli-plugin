import type { EngineInterface, Register, ToolSpec } from 'claude-code';
import { atom, read, update } from 'claude-code';
import type { MultiCoreDisplayTools } from '../types/multi-core.d.ts';
import { accepted, getJson, postJson, type Wire } from './gateway.ts';
import {
  errorBody,
  headerSummary,
  record,
  response,
  resultBody,
  toolHeader,
  unconfirmedBody,
} from './rows-view.ts';
import { rememberBounded } from './state.ts';

/**
 * Native harness actions as Claude Code tool rows.
 *
 * Cursor, Antigravity and Grok run their own tools. The gateway writes each
 * finished native action into the harness's reply as a tool_use block named after
 * the native tool (`mcp__multi-core__run_command`), with the input of the built-in
 * it mirrors, the native parameters under `native` and a one-time token, so the
 * row anchors in the transcript of the session or worker that ran it. This module
 * registers those names, keeps them out of every model's prompt, refuses any call
 * the gateway did not originate, answers the gateway's own with the native output,
 * and draws the row as Claude Code draws the built-in the action mirrors
 * (`rows-view.ts`), under the native tool's name.
 * The names are registered lazily, so a session that never runs a harness model lists
 * none: `register.ts` syncs them at a harness prompt, `workers.ts` before a harness
 * worker spawns, and `lifecycle.ts` before each harness step (a module hooks each
 * event once). What is registered, and the catalog revision it answers, is `$.state`.
 */
const prefix = 'mcp__multi-core__';
const tokenKey = 'multi_row';
const namePattern = /^[A-Za-z0-9_-]{1,47}$/;
const maximumTools = 160;
const maximumRemembered = 512;
const reminder = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const description =
  'Display row for a native Cursor, Antigravity or Grok action. Only the Multi gateway ' +
  'originates it; it is not a tool a model can call.';
const refusal =
  'This is a display row for a native harness action. Only the Multi gateway originates it; ' +
  'it is not a tool a model can call.';

type On = Parameters<Register>[0];
type Row = { output: string; isError: boolean };

// Named where it is read: the engine's scan reads an atom's plugin and key from this file.
const modKeys = atom(
  { plugin: 'multi-core', key: 'modKeys' } as const,
  {} as Record<string, string>,
);

const rowGateway = ($: EngineInterface): RowGateway => ({
  wire: {
    url: () => $.env.get('MULTI_MOD_GATEWAY_URL'),
    token: () => $.env.get('MULTI_GATEWAY_TOKEN'),
    fetch: (url, init) => $.http.fetch(url, init),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
    keys: { read: () => read($, modKeys), save: (change) => update($, modKeys, change) },
  },
  sessionId: () => $.session.id(),
});

/** What answering a display row needs: the gateway and this session's id. */
export type RowGateway = { wire: Wire; sessionId: () => Promise<string> };

/**
 * What syncing needs of the engine. The engine follows `$` only into functions of the
 * file that hooks, so each caller (`register.ts`, `lifecycle.ts`, `workers.ts`) builds
 * this from its own `$`: the state calls are `read`/`update` on `displayTools`.
 */
export type RowsClient = RowGateway & {
  held: () => Promise<MultiCoreDisplayTools>;
  save: (
    change: (held: MultiCoreDisplayTools) => MultiCoreDisplayTools,
  ) => Promise<MultiCoreDisplayTools>;
  register: (tool: ToolSpec) => Promise<unknown>;
};

/**
 * Row inputs by tool_use id: a `ToolResult` carries no input, and its drawing needs it.
 * A render memo (every draw of a row's `ToolUse` refills it), not state a reload loses,
 * and never written from a render hook, which `$.state` refuses.
 */
const inputs = new Map<string, Record<string, unknown>>();

export function isDisplayTool(tool: unknown): tool is string {
  return typeof tool === 'string' && tool.startsWith(prefix);
}

export const register = (on: On) => {
  on('tool.describe', async (_$, event, next) => {
    if (!isDisplayTool(event.tool)) {
      return next(event);
    }
    // Behind ToolSearch, so no model's prompt lists a display row as a tool.
    return { description: event.description, isDeferred: true };
  });
  on('tool.check', async ($, event, next) => {
    if (!isDisplayTool(event.tool)) {
      return next(event);
    }
    const row = await issuedRow(rowGateway($), event.input, event.tool_use_id);
    return row
      ? { decision: 'allow' as const, reason: 'A row the Multi gateway issued for this call.' }
      : { decision: 'deny' as const, reason: refusal };
  });
  on('ui.render', { component: 'ToolUse' }, async ($, event, next) => {
    if (!isDisplayTool(event.props.tool)) {
      return next(event);
    }
    const input = record(event.props.input) ?? {};
    remember(event.props.tool_use_id, input);
    return toolHeader($.ui.resolve(event), {
      name: event.props.tool.slice(prefix.length),
      summary: headerSummary(input, await sessionCwd($)),
      color: dotColor(event.props, input.failed === true, input.unconfirmed === true),
    });
  });
  on('ui.render', { component: 'ToolResult' }, async ($, event, next) => {
    if (!isDisplayTool(event.props.tool)) {
      return next(event);
    }
    const tags = $.ui.resolve(event);
    const input = inputs.get(event.props.tool_use_id) ?? {};
    const output = outputText(event.props.output);
    if (event.props.isErrored || input.failed === true) {
      return response(tags, errorBody(tags, output || 'failed'));
    }
    if (input.unconfirmed === true) {
      return response(tags, unconfirmedBody(tags, output));
    }
    const body = resultBody(tags, input, output, await sessionCwd($));
    if (body) {
      return response(tags, body);
    }
    // The built-in shows the output itself: the engine draws it, a few lines
    // and `… +N lines` in the compact view, all of it under ctrl+o.
    const shown = [{ type: 'text', text: output || '(No output)' }];
    return next({ ...event, props: { ...event.props, output: shown } });
  });
};

/**
 * A display row's call, answered with the native output when the gateway issued its
 * token for this call; any other call to a display name is refused. `register.ts`
 * routes display tools here from the module's one `tool.call` hook.
 */
export async function callDisplayRow(client: RowGateway, event: { tool_use_id?: string }) {
  const row = await issuedRow(client, event, event.tool_use_id);
  if (!row) {
    return { deny: refusal };
  }
  remember(String(event.tool_use_id), event as Record<string, unknown>);
  return row.isError
    ? { isError: true as const, result: row.output }
    : { result: [{ type: 'text', text: row.output }] };
}

function remember(toolUseId: string, input: Record<string, unknown>) {
  rememberBounded(inputs, toolUseId, input, maximumRemembered);
}

async function sessionCwd($: EngineInterface) {
  try {
    return await $.session.cwd();
  } catch {
    return '';
  }
}

/**
 * Registers every display tool the gateway offers that is not registered yet,
 * then tells the gateway which are, since it only emits rows for those.
 */
export async function syncDisplayTools(client: RowsClient) {
  const catalog = record(accepted(await getJson(client.wire, '/multi/mod/display-tools')));
  const known = await client.held();
  if (!catalog || typeof catalog.revision !== 'number' || catalog.revision === known.revision) {
    return;
  }
  const names = (Array.isArray(catalog.names) ? catalog.names : [])
    .filter((name): name is string => typeof name === 'string' && namePattern.test(name))
    .slice(0, maximumTools)
    .filter((name) => !known.registered.includes(name));
  const results = await Promise.allSettled(
    names.map((name) =>
      client.register({
        name,
        description,
        inputSchema: { type: 'object', additionalProperties: true },
      }),
    ),
  );
  // A toolless session cannot register tools; its gateway emits no rows.
  const complete = results.every((result) => result.status === 'fulfilled');
  const registered = [
    ...known.registered,
    ...names.filter((_name, index) => results[index]?.status === 'fulfilled'),
  ];
  // The revision advances only once the gateway confirmed the registered set; a
  // timeout or an HTTP failure (which the client returns as no reply) is retried
  // on the next sync, with the names registered so far kept.
  const confirmed = await acknowledged(client, registered);
  const revision = complete && confirmed ? (catalog.revision as number) : undefined;
  await client.save((latest) =>
    revision === undefined ? { ...latest, registered } : { registered, revision },
  );
}

/** Tells the gateway which names are registered; true only for its validated reply. */
async function acknowledged(client: RowsClient, registered: readonly string[]): Promise<boolean> {
  if (!registered.length) {
    return true;
  }
  const reply = record(
    accepted(
      await postJson(client.wire, '/multi/mod/display-tools', {
        sessionId: await client.sessionId(),
        registered,
      }),
    ),
  );
  return typeof reply?.registered === 'number';
}

/** The native output of a row, only when the gateway issued its token for this call. */
async function issuedRow(client: RowGateway, input: unknown, toolUseId: unknown) {
  const token = record(input)?.[tokenKey];
  if (typeof token !== 'string' || typeof toolUseId !== 'string') {
    return undefined;
  }
  const reply = record(
    accepted(
      await postJson(client.wire, '/multi/mod/display', {
        sessionId: await client.sessionId(),
        token,
        toolUseId,
      }),
    ),
  );
  if (!reply || typeof reply.output !== 'string') {
    return undefined;
  }
  return { output: reply.output, isError: reply.isError === true } satisfies Row;
}

/** The row's dot: red for a failure, grey while running or when never confirmed, else green. */
function dotColor(
  props: { isRunning: boolean; isErrored: boolean; isInterrupted: boolean },
  failed: boolean,
  unconfirmed: boolean,
) {
  if (props.isErrored || props.isInterrupted || failed) {
    return 'error';
  }
  return props.isRunning || unconfirmed ? 'inactive' : 'success';
}

/** A row's stored result as text: the text blocks joined, reminders removed. */
export function outputText(output: unknown): string {
  let text = '';
  if (typeof output === 'string') {
    text = output;
  } else if (Array.isArray(output)) {
    text = output
      .map((block) => {
        const value = record(block)?.text;
        return typeof value === 'string' ? value : '';
      })
      .join('\n');
  }
  return text.replaceAll(reminder, '').replaceAll('\r', '').trimEnd();
}

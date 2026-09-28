import type { EngineInterface, Register, ToolSpec } from 'claude-code';
import {
  errorBody,
  headerSummary,
  record,
  response,
  resultBody,
  toolHeader,
  unconfirmedBody,
} from './rows-view.ts';

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
 * `register.ts` syncs the names at session start and `lifecycle.ts` before each
 * harness step (a module hooks each event once), both through a `RowsClient`.
 */
const prefix = 'mcp__multi-core__';
const tokenKey = 'multi_row';
const namePattern = /^[A-Za-z0-9_-]{1,47}$/;
const maximumTools = 160;
const maximumBody = 32000;
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

const registered = new Set<string>();
/** Row inputs by tool_use id: a `ToolResult` carries no input, and its drawing needs it. */
const inputs = new Map<string, Record<string, unknown>>();
let revision: number | undefined;

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
    const row = await issuedRow($, event.input, event.tool_use_id);
    return row
      ? { decision: 'allow' as const, reason: 'A row the Multi gateway issued for this call.' }
      : { decision: 'deny' as const, reason: refusal };
  });
  on('tool.call', async ($, event, next) => {
    if (!isDisplayTool(event.tool)) {
      return next(event);
    }
    const row = await issuedRow($, event, event.tool_use_id);
    if (!row) {
      return { deny: refusal };
    }
    remember(event.tool_use_id, event);
    return row.isError
      ? { isError: true as const, result: row.output }
      : { result: [{ type: 'text', text: row.output }] };
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

function remember(toolUseId: string, input: Record<string, unknown>) {
  inputs.delete(toolUseId);
  inputs.set(toolUseId, input);
  while (inputs.size > maximumRemembered) {
    inputs.delete(inputs.keys().next().value as string);
  }
}

async function sessionCwd($: EngineInterface) {
  try {
    return await $.session.cwd();
  } catch {
    return '';
  }
}

/**
 * What syncing needs from the engine and the gateway. The engine passes `$` only
 * into functions of the module that hooks, so each caller builds this from its
 * own `$` (as `policy.ts` takes a `PolicyClient`).
 */
export type RowsClient = {
  sessionId: () => Promise<string>;
  /** `GET /multi/mod/display-tools`: the gateway's offered names and their revision. */
  catalog: () => Promise<unknown>;
  register: (tool: ToolSpec) => Promise<unknown>;
  /** `POST /multi/mod/display-tools`: the names now registered. */
  acknowledge: (payload: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Registers every display tool the gateway offers that is not registered yet,
 * then tells the gateway which are, since it only emits rows for those.
 */
export async function syncDisplayTools(client: RowsClient) {
  const catalog = record(await client.catalog());
  if (!catalog || typeof catalog.revision !== 'number' || catalog.revision === revision) {
    return;
  }
  const names = (Array.isArray(catalog.names) ? catalog.names : [])
    .filter((name): name is string => typeof name === 'string' && namePattern.test(name))
    .slice(0, maximumTools)
    .filter((name) => !registered.has(name));
  const results = await Promise.allSettled(
    names.map((name) =>
      client.register({
        name,
        description,
        inputSchema: { type: 'object', additionalProperties: true },
      }),
    ),
  );
  let complete = true;
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      registered.add(names[index] as string);
    } else {
      // A toolless session cannot register tools; its gateway emits no rows.
      complete = false;
    }
  }
  // The revision advances only once the gateway confirmed the registered set; a
  // timeout or an HTTP failure (which the client returns as no reply) is retried
  // on the next sync, with the names registered so far kept.
  const confirmed = await acknowledged(client);
  if (complete && confirmed) {
    revision = catalog.revision;
  }
}

/** Tells the gateway which names are registered; true only for its validated reply. */
async function acknowledged(client: RowsClient): Promise<boolean> {
  if (!registered.size) {
    return true;
  }
  const reply = record(
    await client.acknowledge({
      sessionId: await client.sessionId(),
      registered: [...registered],
    }),
  );
  return typeof reply?.registered === 'number';
}

/** The native output of a row, only when the gateway issued its token for this call. */
async function issuedRow($: EngineInterface, input: unknown, toolUseId: unknown) {
  const token = record(input)?.[tokenKey];
  if (typeof token !== 'string' || typeof toolUseId !== 'string') {
    return undefined;
  }
  const reply = record(
    await gateway($, '/multi/mod/display', {
      sessionId: await $.session.id(),
      token,
      toolUseId,
    }),
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

async function gateway($: EngineInterface, route: string, payload?: Record<string, unknown>) {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  if (!base || !token) {
    return undefined;
  }
  const body = payload ? JSON.stringify(payload) : undefined;
  if (body && body.length > maximumBody) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      $.http.fetch(`${base}${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
        ...(body ? { body } : {}),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Gateway timeout')), 1500);
      }),
    ]);
    return response.ok ? (JSON.parse(response.text) as unknown) : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

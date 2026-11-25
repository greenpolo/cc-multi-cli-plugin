import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DisplayRows } from './display-rows.ts';
import type { ModBridge } from './mod-bridge.ts';
import type { ModCompactions } from './mod-compaction.ts';
import type { ModSessionKeys } from './mod-keys.ts';
import { usageRoute } from './mod-usage.ts';
import type { PermissionContext, PermissionModes } from './mode-hook.ts';
import type { ProviderUsageDashboard } from './provider-usage.ts';
import type { ReceiptLedger } from './receipts.ts';
import { isRecord } from './record.ts';
import type { WorkerModels } from './worker-models.ts';

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
function reply(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function sessionKey(sessionId: string, agentId: unknown) {
  if (agentId !== undefined && agentId !== null) {
    text(agentId, 'agentId');
  }
  return JSON.stringify([sessionId, typeof agentId === 'string' ? agentId : 'main']);
}
function method(req: IncomingMessage, expected: string) {
  if (req.method !== expected) {
    throw new Error(`Mod route requires ${expected}`);
  }
}

/** The gateway state the mod control plane reads and acts on. */
export interface ModRouteContext {
  bridge: ModBridge;
  workerModels?: WorkerModels;
  reviewStatement?: (model: string) => string | undefined;
  forgetReviewContext?: (session: string) => void;
  permissionModes?: PermissionModes;
  compactions?: ModCompactions;
  receipts?: ReceiptLedger;
  billed?: { scope: string; read(session: string): Promise<unknown> };
  dashboard?: ProviderUsageDashboard;
  rows?: DisplayRows;
  /** The per-session keys; a detached session's key is dropped with the session. */
  keys?: ModSessionKeys;
  /** Ends a gateway its mod started (serve.ts); a launcher's gateway ends with its Claude. */
  stop?: () => void;
}

export async function handleModRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parsed: unknown,
  context: ModRouteContext,
) {
  const { bridge, receipts, billed, dashboard, rows } = context;
  try {
    if (
      ['/multi/mod/usage', '/multi/mod/receipts', '/multi/mod/usage/complete'].includes(
        url.pathname,
      )
    ) {
      if (!receipts) {
        throw new Error('Usage accounting is unavailable');
      }
      return reply(res, await usageRoute(req, url, parsed, receipts, billed, dashboard));
    }
    switch (url.pathname) {
      case '/multi/mod/telemetry':
        if (req.method === 'POST') {
          return handlePostRoute(req, res, url.pathname, parsed, context);
        }
        method(req, 'GET');
        return reply(
          res,
          bridge.step(
            sessionKey(
              text(url.searchParams.get('sessionId'), 'sessionId'),
              url.searchParams.get('agentId'),
            ),
          ) ?? {},
        );
      case '/multi/mod/lifecycle':
        method(req, 'GET');
        return reply(
          res,
          bridge.status(
            sessionKey(
              text(url.searchParams.get('sessionId'), 'sessionId'),
              url.searchParams.get('agentId'),
            ),
          ) ?? {},
        );
      case '/multi/mod/display-tools':
        if (req.method === 'GET') {
          return reply(res, rows?.catalog() ?? { revision: 0, names: [] });
        }
        return displayRoute(req, res, url.pathname, parsed, rows);
      case '/multi/mod/display':
        return displayRoute(req, res, url.pathname, parsed, rows);
      case '/multi/mod/mode':
        method(req, 'GET');
        return modeRoute(
          res,
          text(url.searchParams.get('sessionId'), 'sessionId'),
          url.searchParams.get('agentId'),
          bridge,
        );
      default:
        return await handlePostRoute(req, res, url.pathname, parsed, context);
    }
  } catch (error) {
    return reply(
      res,
      { error: error instanceof Error ? error.message : 'Invalid mod request' },
      400,
    );
  }
}

async function handlePostRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  parsed: unknown,
  context: ModRouteContext,
) {
  const { bridge, permissionModes, compactions, rows, keys } = context;
  method(req, 'POST');
  if (!isRecord(parsed)) {
    throw new Error('Expected an object');
  }
  const sessionId = text(parsed.sessionId, 'sessionId');
  const key = sessionKey(sessionId, parsed.agentId);
  if (route.startsWith('/multi/mod/compact/')) {
    return compactRoute(res, route, parsed, context);
  }
  switch (route) {
    case '/multi/mod/stop':
      if (!context.stop) {
        throw new Error('This gateway ends with the Claude its launcher started');
      }
      res.once('finish', context.stop);
      return reply(res, { accepted: true });
    case '/multi/mod/detach':
      context.forgetReviewContext?.(sessionId);
      compactions?.cancel(sessionId);
      bridge.forgetSession(sessionId);
      rows?.forgetSession(sessionId);
      permissionModes?.forgetSession(sessionId);
      keys?.forget(sessionId);
      return reply(res, { accepted: true });
    case '/multi/mod/telemetry':
      bridge.observeStep(key, {
        model: text(parsed.model, 'model'),
        effort: telemetryEffort(parsed.effort),
      });
      return reply(res, {
        accepted: true,
        reviewStatement: context.reviewStatement?.(String(parsed.model)),
      });
    case '/multi/mod/session':
      return sessionRoute(res, parsed, key, bridge, permissionModes);
    case '/multi/mod/offer':
      await permissionModes?.ready(text(parsed.cwd, 'cwd'));
      return reply(res, {
        ...permissionModes?.workerSelection({ ...parsed, subagentType: parsed.agent }),
        isOffered:
          permissionModes?.offered(text(parsed.cwd, 'cwd'), text(parsed.agent, 'agent')) ?? false,
      });
    case '/multi/mod/worker-model':
      if (!permissionModes) {
        throw new Error('Worker catalog is unavailable');
      }
      await permissionModes.ready(text(parsed.cwd, 'cwd'));
      return reply(
        res,
        permissionModes.workerSelection(context.workerModels?.selection(parsed) ?? parsed),
      );
    case '/multi/mod/worker':
      return await workerRoute(res, parsed, key, permissionModes);
    default:
      throw new Error('Unknown mod route');
  }
}

/**
 * Display rows: the mod acknowledges the display tools it registered, and
 * answers a row's call with the native output only for a token this gateway
 * issued for that session and call. Any other call is refused.
 */
function displayRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  parsed: unknown,
  rows: DisplayRows | undefined,
) {
  method(req, 'POST');
  if (!isRecord(parsed)) {
    throw new Error('Expected an object');
  }
  const sessionId = text(parsed.sessionId, 'sessionId');
  if (!rows) {
    throw new Error('Display rows are unavailable');
  }
  if (route === '/multi/mod/display-tools') {
    return reply(res, rows.acknowledge(sessionId, parsed.registered));
  }
  const row = rows.verify(sessionId, parsed.token, parsed.toolUseId);
  if (!row) {
    return reply(
      res,
      { error: 'This row was not issued by the Multi gateway for this call.' },
      403,
    );
  }
  return reply(res, row);
}
function modeRoute(res: ServerResponse, sessionId: string, agentId: unknown, bridge: ModBridge) {
  const snapshot = bridge.mode(sessionKey(sessionId, agentId));
  return snapshot ? reply(res, snapshot) : reply(res, { accepted: false, stale: true }, 409);
}
function sessionRoute(
  res: ServerResponse,
  value: Record<string, unknown>,
  key: string,
  bridge: ModBridge,
  permissionModes?: PermissionModes,
) {
  const session = JSON.parse(key)[0] as string;
  const effective = effectivePolicy(value);
  // A snapshot without a mode records nothing and never blocks Claude's prompt.
  if (permissionModes && typeof effective.permissionMode === 'string') {
    permissionModes.recordSession(session, {
      ...effective,
      permissionMode: validatedMode(effective.permissionMode),
      model: value.model === undefined ? undefined : text(value.model, 'model'),
      cwd: optionalText(value.cwd),
    });
  }
  const snapshot = bridge.recordSession(key, { effective, cwd: optionalText(value.cwd) });
  if (snapshot && value.event === 'start') {
    process.emit('multi-mod-session-start');
  }
  return snapshot
    ? reply(res, { accepted: true, ...snapshot })
    : reply(res, { accepted: false, stale: true }, 409);
}
/**
 * An Agent call announces its worker, then Claude Code reports the worker's start (with
 * its `agentId`). Neither is a gate: both only record what the worker's runs answer to.
 */
async function workerRoute(
  res: ServerResponse,
  value: Record<string, unknown>,
  key: string,
  permissionModes?: PermissionModes,
) {
  if (!permissionModes) {
    throw new Error('Native worker policy is unavailable');
  }
  const session = JSON.parse(key)[0] as string;
  await permissionModes.ready(text(value.cwd, 'cwd'));
  if (typeof value.agentId === 'string') {
    permissionModes.startWorker(
      session,
      text(value.agentId, 'agentId'),
      text(value.subagentType, 'subagentType'),
      text(value.cwd, 'cwd'),
    );
    return reply(res, {
      accepted: true,
      model: permissionModes.resolve(session, value.agentId).model,
    });
  }
  permissionModes.prepareWorker(session, value);
  return reply(res, { accepted: true });
}
function optionalText(value: unknown) {
  return value === undefined ? undefined : text(value, 'cwd');
}
function optionalGeneration(value: Record<string, unknown>) {
  if (value.generation === undefined) {
    return undefined;
  }
  if (typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation)) {
    throw new Error('Invalid generation');
  }
  return value.generation;
}
function stringArray(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some((item) => typeof item !== 'string' || !item || item.length > 512)
  ) {
    throw new Error('Invalid policy tool list');
  }
  return value.slice();
}
function effectivePolicy(value: Record<string, unknown>) {
  const permissionMode =
    value.permissionMode === undefined ? undefined : text(value.permissionMode, 'permissionMode');
  return {
    permissionMode,
    tools: stringArray(value.tools),
    disallowedTools: stringArray(value.disallowedTools),
  };
}

function telemetryEffort(value: unknown): string | number | undefined {
  if (value === undefined || (typeof value === 'number' && Number.isFinite(value))) {
    return value;
  }
  return text(value, 'effort');
}

function validatedMode(value: string): PermissionContext['permissionMode'] {
  switch (value) {
    case 'default':
    case 'acceptEdits':
    case 'auto':
    case 'dontAsk':
    case 'bypassPermissions':
    case 'plan':
      return value;
    default:
      // A mode this gateway does not know runs as Claude's default does.
      return 'default';
  }
}

function compactRoute(
  res: ServerResponse,
  route: string,
  value: Record<string, unknown>,
  { bridge, permissionModes: modes, compactions }: ModRouteContext,
) {
  const session = text(value.sessionId, 'sessionId');
  if (route === '/multi/mod/compact/cancel') {
    const agentId = value.agentId === undefined ? undefined : text(value.agentId, 'agentId');
    compactions?.cancelScope(session, agentId);
    // A cancelled compaction also disarms its permission boundary, the main loop's included.
    modes?.cancelModCompaction(session, agentId);
    return reply(res, { accepted: true });
  }
  const generation = optionalGeneration(value);
  const current = bridge.mode(sessionKey(session, undefined));
  if (!modes || !compactions || !current || generation !== current.generation) {
    throw new Error('Compaction policy generation is unknown or stale');
  }
  const agent = value.agentId === undefined ? undefined : text(value.agentId, 'agentId');
  const identity = { session, agent, generation: current.generation };
  if (route === '/multi/mod/compact/run') {
    const context = modes.resolve(session, agent);
    return reply(res, compactions.run(identity, text(value.precomputeId, 'precomputeId'), context));
  }
  const input = {
    ...identity,
    messages: value.messages === undefined ? [] : transcript(value.messages),
    instructions: compactInstructions(value.instructions),
  };
  if (route === '/multi/mod/compact/precompute') {
    if (!input.messages.length) {
      throw new Error('Precompute requires a transcript');
    }
    modes.resolve(session, agent);
    return reply(res, compactions.prepare(input));
  }
  if (route !== '/multi/mod/compact/authorize') {
    throw new Error('Unknown compaction route');
  }
  const result = compactions.authorize(input);
  if (!result.messages) {
    authorizeBoundary(modes, session, agent);
  }
  return reply(res, result);
}

function authorizeBoundary(modes: PermissionModes, session: string, agent?: string) {
  if (agent) {
    modes.resolve(session, agent);
    modes.authorizeModCompaction(session, agent);
    return;
  }
  modes.authorizeRestoredModCompaction(session);
}
function transcript(value: unknown): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 256 ||
    value.some((item) => !isRecord(item))
  ) {
    throw new Error('Invalid bounded compaction transcript');
  }
  return value;
}
function compactInstructions(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > 4096) {
    throw new Error('Invalid compaction instructions');
  }
  return value;
}

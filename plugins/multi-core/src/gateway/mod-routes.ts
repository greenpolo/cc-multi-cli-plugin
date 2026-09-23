import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DisplayRows } from './display-rows.ts';
import type { ModBridge } from './mod-bridge.ts';
import type { ModCompactions } from './mod-compaction.ts';
import { usageRoute } from './mod-usage.ts';
import type { PermissionContext, PermissionModes } from './mode-hook.ts';
import type { ProviderUsageDashboard } from './provider-usage.ts';
import type { ReceiptLedger } from './receipts.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
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

export async function handleModRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parsed: unknown,
  bridge: ModBridge,
  permissionModes?: PermissionModes,
  compactions?: ModCompactions,
  receipts?: ReceiptLedger,
  billedUsage?: (session: string) => Promise<unknown>,
  dashboard?: ProviderUsageDashboard,
  rows?: DisplayRows,
) {
  try {
    if (
      ['/multi/mod/usage', '/multi/mod/receipts', '/multi/mod/usage/complete'].includes(
        url.pathname,
      )
    ) {
      if (!receipts) {
        throw new Error('Usage accounting is unavailable');
      }
      return reply(res, await usageRoute(req, url, parsed, receipts, billedUsage, dashboard));
    }
    switch (url.pathname) {
      case '/multi/mod/telemetry':
        if (req.method === 'POST') {
          return handlePostRoute(
            req,
            res,
            url.pathname,
            parsed,
            bridge,
            permissionModes,
            compactions,
            rows,
          );
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
        return await handlePostRoute(
          req,
          res,
          url.pathname,
          parsed,
          bridge,
          permissionModes,
          compactions,
          rows,
        );
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
  bridge: ModBridge,
  permissionModes?: PermissionModes,
  compactions?: ModCompactions,
  rows?: DisplayRows,
) {
  method(req, 'POST');
  if (!record(parsed)) {
    throw new Error('Expected an object');
  }
  const sessionId = text(parsed.sessionId, 'sessionId');
  const key = sessionKey(sessionId, parsed.agentId);
  if (route.startsWith('/multi/mod/compact/')) {
    return compactRoute(res, route, parsed, bridge, permissionModes, compactions);
  }
  switch (route) {
    case '/multi/mod/policy':
      if (parsed.generation === undefined) {
        if (parsed.sourceGeneration !== bridge.mode(key)?.generation) {
          throw new Error('Policy source generation is stale');
        }
        compactions?.cancel(sessionId);
      }
      if (!permissionModes) {
        throw new Error('Policy admission is unavailable');
      }
      return reply(
        res,
        parsed.generation === undefined
          ? permissionModes.beginPolicy(sessionId, text(parsed.cwd, 'cwd'))
          : permissionModes.policies.status(sessionId, text(parsed.generation, 'generation')),
      );
    case '/multi/mod/detach':
      compactions?.cancel(sessionId);
      bridge.forgetSession(sessionId);
      rows?.forgetSession(sessionId);
      permissionModes?.forgetSession(sessionId);
      return reply(res, { accepted: true });
    case '/multi/mod/telemetry':
      bridge.observeStep(key, {
        model: text(parsed.model, 'model'),
        effort: telemetryEffort(parsed.effort),
      });
      return reply(res, { accepted: true });
    case '/multi/mod/session':
      return sessionRoute(res, parsed, key, bridge, permissionModes);
    case '/multi/mod/offer':
      return reply(res, {
        ...permissionModes?.workerSelection({ ...parsed, subagentType: parsed.agent }),
        isOffered:
          permissionModes?.offered(text(parsed.cwd, 'cwd'), text(parsed.agent, 'agent')) ?? false,
      });
    case '/multi/mod/worker-model':
      if (!permissionModes) {
        throw new Error('Worker catalog is unavailable');
      }
      return reply(res, permissionModes.workerSelection(parsed));
    case '/multi/mod/worker':
      return await workerRoute(res, parsed, key, bridge, permissionModes);
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
  if (!record(parsed)) {
    throw new Error('Expected an object');
  }
  const sessionId = text(parsed.sessionId, 'sessionId');
  if (!rows) {
    throw new Error('Display rows are unavailable');
  }
  if (route === '/multi/mod/display-tools') {
    return reply(res, rows.acknowledge(parsed.registered));
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
  const generation = optionalGeneration(value);
  if (generation !== undefined && generation !== bridge.mode(key)?.generation) {
    return reply(res, { accepted: false, stale: true }, 409);
  }
  // A snapshot without a mode admits no policy and never blocks Claude's prompt.
  if (permissionModes && typeof effective.permissionMode === 'string') {
    const context: PermissionContext = {
      ...effective,
      permissionMode: validatedMode(effective.permissionMode),
      model: value.model === undefined ? undefined : text(value.model, 'model'),
      cwd: optionalText(value.cwd),
    };
    if (value.policyGeneration !== undefined) {
      permissionModes.admitPolicy(
        session,
        text(value.policyGeneration, 'policyGeneration'),
        context,
      );
    } else {
      permissionModes.recordHostSession(session, context);
    }
  }
  const snapshot = bridge.recordSession(key, {
    effective,
    cwd: optionalText(value.cwd),
    generation,
  });
  if (snapshot && value.event === 'start') {
    process.emit('multi-mod-session-start');
  }
  return snapshot
    ? reply(res, { accepted: true, ...snapshot })
    : reply(res, { accepted: false, stale: true }, 409);
}
async function workerRoute(
  res: ServerResponse,
  value: Record<string, unknown>,
  key: string,
  bridge: ModBridge,
  permissionModes?: PermissionModes,
) {
  if (!permissionModes) {
    throw new Error('Native worker policy is unavailable');
  }
  const session = JSON.parse(key)[0] as string;
  if (typeof value.agentId === 'string') {
    permissionModes.startPreparedModWorker(
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
  if (permissionModes.workerSelection(value).execution === 'harness') {
    const snapshot = bridge.mode(sessionKey(session, undefined));
    if (!snapshot || value.generation !== snapshot.generation) {
      throw new Error('Worker policy generation is unavailable or stale');
    }
  }
  const workerToken = await permissionModes.prepareModWorker(session, value);
  return reply(res, { accepted: true, workerToken });
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
      throw new Error('Unsupported permission mode');
  }
}

function compactRoute(
  res: ServerResponse,
  route: string,
  value: Record<string, unknown>,
  bridge: ModBridge,
  modes?: PermissionModes,
  compactions?: ModCompactions,
) {
  const session = text(value.sessionId, 'sessionId');
  if (route === '/multi/mod/compact/cancel') {
    compactions?.cancelScope(
      session,
      value.agentId === undefined ? undefined : text(value.agentId, 'agentId'),
    );
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
    value.some((item) => !record(item))
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

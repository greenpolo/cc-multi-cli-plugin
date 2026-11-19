// One gateway request: its admission, its identity and its parsed body.

import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type { MessagesRequest, TerminalEmit } from './messages.ts';
import { MOD_KEY_HEADER, type ModSessionKeys } from './mod-keys.ts';
import type { PermissionContext } from './mode-hook.ts';
import type { NativeHarness } from './native-harness.ts';
import { harnessProvider, providerManifest, providerOf } from './provider.ts';
import { isRecord } from './record.ts';

// Anthropic's own Messages API limit is 32 MB; the gateway buffers up to it and leaves
// the verdict to the provider, so a request Claude Code could send natively still goes.
const MAX_BODY = 32 * 1024 * 1024;

/** Rejected before any provider call; answered as HTTP 400 rather than 502. */
export class BadRequest extends Error {}

export class ForbiddenHost extends Error {}

export class RequestTooLarge extends Error {}

export const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function authenticated(actual: string | string[] | undefined, expected: string): boolean {
  const a = Buffer.from(String(actual ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

export interface ProviderRequest {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  body: MessagesRequest;
  parsed: Record<string, unknown>;
  raw: Buffer;
  url: URL;
  signal: AbortSignal;
  abort: AbortController;
  agentId?: string;
  identity: ReturnType<typeof requestIdentity>;
  permissionContext?: PermissionContext;
  emit: TerminalEmit;
  startStream: () => void;
  /** Arms the non-streamed keepalive before a slow upstream wait; a stream needs none. */
  keepAlive: () => void;
}

/**
 * The gateway token alone does not authorize a mod request that changes a session: the
 * token is in the environment of Claude's own tools. See mod-keys.ts.
 */
export function admitModRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsed: Record<string, unknown>,
  keys: ModSessionKeys,
) {
  if (req.method !== 'POST' || typeof parsed.sessionId !== 'string' || !parsed.sessionId) {
    return true;
  }
  const verdict = keys.check(parsed.sessionId, header(req.headers[MOD_KEY_HEADER]));
  if (verdict.refused) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Mod session key required' }));
    return false;
  }
  if (verdict.issue) {
    res.setHeader(MOD_KEY_HEADER, verdict.issue);
  }
  return true;
}

/**
 * Only the gateway's own loopback name and port are accepted as the `Host`. A web page
 * that rebinds its DNS name to 127.0.0.1 reaches the port with its own name in `Host`,
 * which is what keeps it from using the unauthenticated raw passthrough as a relay.
 */
export function assertLoopbackHost(req: http.IncomingMessage) {
  const host = req.headers.host?.toLowerCase();
  const port = req.socket.localPort;
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!host || !allowed.includes(host)) {
    throw new ForbiddenHost('Forbidden host');
  }
}

/** A request body is present when the client declared one, whatever the method. */
export function requestHasBody(req: http.IncomingMessage) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return false;
  }
  return (
    req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0
  );
}

export function providerSignal(
  disconnected: AbortSignal,
  model: string | null,
  timeoutMs?: number,
) {
  // Native harness runs follow the client connection rather than an HTTP deadline.
  if (harnessProvider(model)) {
    return disconnected;
  }
  // Streamed OpenAI, Zen and Claude responses (including server-side advisor calls)
  // can outlive any fixed wall-clock deadline; only an explicit limit bounds them.
  if (timeoutMs === undefined) {
    return disconnected;
  }
  return AbortSignal.any([disconnected, AbortSignal.timeout(timeoutMs)]);
}

export async function readRequest(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > (req.url?.startsWith('/multi/mod/') ? 32 * 1024 : MAX_BODY)) {
      throw new RequestTooLarge();
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    throw new BadRequest('Invalid JSON');
  }
  if (!isRecord(parsed) || (parsed.model !== undefined && typeof parsed.model !== 'string')) {
    throw new BadRequest('Expected an object with a string model');
  }
  return { raw, parsed, body: parsed as MessagesRequest };
}

export function requestIdentity(
  parsed: Record<string, unknown>,
  agentId?: string,
  sessionHeader?: string,
  provider = true,
) {
  const rawIdentity =
    isRecord(parsed.metadata) && typeof parsed.metadata.user_id === 'string'
      ? parsed.metadata.user_id
      : undefined;
  let session = '';
  if (rawIdentity) {
    try {
      const metadata: unknown = JSON.parse(rawIdentity);
      if (isRecord(metadata) && typeof metadata.session_id === 'string') {
        session = metadata.session_id;
      }
    } catch {
      /* Unknown identity cannot grant auto capability. */
    }
  }
  // Session identity matters to provider routes and to classifier requests that go to
  // provider review (checked at dispatch). A Claude passthrough request is never refused
  // for it: Anthropic owns that request.
  const mismatch = Boolean(session && sessionHeader && session !== sessionHeader);
  if (provider && mismatch) {
    throw new BadRequest('Session header and metadata disagree');
  }
  session = session || sessionHeader || '';
  const identity = session || rawIdentity;
  return {
    identity,
    session,
    mismatch,
    scope: identity ? JSON.stringify([identity, agentId ?? 'main']) : undefined,
  };
}

export function authorizeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
) {
  if (req.headers.origin || !authenticated(req.headers['x-multi-gateway-token'], token)) {
    const pathName = new URL(req.url ?? '', 'http://localhost').pathname;
    res.writeHead(pathName.startsWith('/multi/mod/') ? 401 : 403);
    res.end('Forbidden');
    return false;
  }
  const url = new URL(req.url ?? '', 'http://localhost');
  if (
    ![
      '/v1/messages',
      '/v1/messages/count_tokens',
      '/multi/mod/session',
      '/multi/mod/worker',
      '/multi/mod/worker-model',
      '/multi/mod/mode',
      '/multi/mod/policy',
      '/multi/mod/offer',
      '/multi/mod/telemetry',
      '/multi/mod/lifecycle',
      '/multi/mod/display',
      '/multi/mod/display-tools',
      '/multi/mod/usage',
      '/multi/mod/usage/complete',
      '/multi/mod/receipts',
      '/multi/mod/detach',
      '/multi/mod/compact/precompute',
      '/multi/mod/compact/run',
      '/multi/mod/compact/authorize',
      '/multi/mod/compact/cancel',
    ].includes(url.pathname) ||
    !['POST', 'GET', 'HEAD'].includes(req.method ?? '')
  ) {
    res.writeHead(404);
    res.end('Not found');
    return false;
  }
  return true;
}

export function assertProviderEnabled(
  model: string | null,
  enabled: readonly string[] | undefined,
) {
  if (model && enabled && !enabled.includes(model.split('/')[1])) {
    throw new BadRequest('This provider plugin is not enabled for this session.');
  }
}

/** Where a model's traffic goes: its provider, Anthropic without one, itself if unknown. */
export function routeOf(model: string | null | undefined): string {
  if (!model) {
    return 'anthropic';
  }
  return providerOf(model) ?? model.split('/')[1] ?? model;
}

/** What a request for a provider this session does not run is told. */
export function unavailable(provider: string): string {
  return (
    providerManifest(provider)?.unavailable ??
    `${providerManifest(provider)?.label ?? provider} is not available in this session.`
  );
}

export function externalModel(model: unknown) {
  return typeof model === 'string' && model.startsWith('multi/') ? model : null;
}

export function validateHarness(
  exchange: ProviderRequest,
  provider: string,
  bridge: NativeHarness,
) {
  try {
    if (
      !['/v1/messages', '/v1/messages/count_tokens'].includes(exchange.url.pathname) ||
      exchange.req.method !== 'POST'
    ) {
      throw new Error(`${provider} requires POST /v1/messages or /v1/messages/count_tokens`);
    }
    return bridge.validate(exchange.body, exchange.permissionContext);
  } catch (error) {
    throw new BadRequest(reason(error));
  }
}

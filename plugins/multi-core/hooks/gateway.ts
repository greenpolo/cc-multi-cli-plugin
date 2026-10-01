import type { HttpInit, HttpResponse, SessionMessage } from 'claude-code';

/**
 * The one client for the authenticated loopback `/multi/mod/*` control plane.
 *
 * Every hook reaches the gateway through `getJson` or `postJson`: the method is
 * explicit, a body is bounded in bytes, and the wait is bounded by `$.clock` (a hooks
 * module has no timers). `undefined` means the gateway is dormant, unreachable, slow or
 * answered something that is not JSON; a refused reply (any non-2xx status) comes back
 * with `refused` set and the gateway's reason, never with its body, so a caller that
 * checks only `accepted` still fails closed.
 */
const maxBody = 32000;
const defaultTimeoutMs = 1500;

export type GatewayResponse = {
  refused?: true;
  httpStatus?: number;
  error?: string;
  accepted?: boolean;
  generation?: number | string;
  status?: string;
  stale?: boolean;
  isOffered?: boolean;
  execution?: 'claude' | 'harness';
  known?: boolean;
  model?: string;
  precomputeId?: string;
  allow?: boolean;
  messages?: readonly SessionMessage[];
  [field: string]: unknown;
};

export type GatewayOptions = {
  /** How long to wait; 0 waits on the gateway's own bound (a held long poll). */
  timeoutMs?: number;
  /** Ends the wait early, as `next.signal` ends a hook's with its dispatch. */
  signal?: AbortSignal;
};

/**
 * What the client needs of the engine, as four calls. The engine follows `$` only into
 * functions of the file that hooks, never across an import, and wants each `$.env.get`
 * name and `$.noun.event(...)` spelled at its call site, so each hooks file builds this
 * from its own `$` and hands it here:
 *
 *     const wire = ($: EngineInterface): Wire => ({
 *       url: () => $.env.get('MULTI_MOD_GATEWAY_URL'),
 *       token: () => $.env.get('MULTI_GATEWAY_TOKEN'),
 *       fetch: (url, init) => $.http.fetch(url, init),
 *       sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
 *     });
 */
export type Wire = {
  url: () => Promise<string | undefined>;
  token: () => Promise<string | undefined>;
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

type Environment = { base: string; token: string };

async function environment(wire: Wire): Promise<Environment | undefined> {
  const base = await wire.url();
  const token = await wire.token();
  return base && token ? { base, token } : undefined;
}

/** Whether this session was launched with the gateway's Mod control plane. */
export async function isActive(wire: Wire): Promise<boolean> {
  return (await environment(wire)) !== undefined;
}

export function getJson<T extends GatewayResponse = GatewayResponse>(
  wire: Wire,
  route: string,
  query: Record<string, string> = {},
  options: GatewayOptions = {},
): Promise<T | undefined> {
  const search = new URLSearchParams(query).toString();
  return send<T>(wire, 'GET', search ? `${route}?${search}` : route, undefined, options);
}

export function postJson<T extends GatewayResponse = GatewayResponse>(
  wire: Wire,
  route: string,
  payload: object,
  options: GatewayOptions = {},
): Promise<T | undefined> {
  return send<T>(wire, 'POST', route, JSON.stringify(payload), options);
}

/** The reply only when the gateway accepted the request. */
export function accepted<T extends GatewayResponse>(reply: T | undefined): T | undefined {
  return reply && !reply.refused ? reply : undefined;
}

async function send<T extends GatewayResponse>(
  wire: Wire,
  method: 'GET' | 'POST',
  route: string,
  body: string | undefined,
  options: GatewayOptions,
): Promise<T | undefined> {
  const env = await environment(wire);
  if (!env || (body !== undefined && new TextEncoder().encode(body).length > maxBody)) {
    return undefined;
  }
  const waiting = new AbortController();
  const cancel = () => waiting.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const fetched = wire.fetch(`${env.base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-multi-gateway-token': env.token },
      ...(body === undefined ? {} : { body }),
    });
    // A late failure of a fetch that lost the race to its deadline is not reported.
    fetched.catch(() => undefined);
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const result =
      timeoutMs > 0
        ? await Promise.race([fetched, deadline(wire, timeoutMs, waiting.signal)])
        : await fetched;
    return result.ok ? (JSON.parse(result.text) as T) : (refusal(result) as T);
  } catch {
    return undefined;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    waiting.abort();
  }
}

async function deadline(wire: Wire, ms: number, signal: AbortSignal): Promise<never> {
  await wire.sleep(ms, signal);
  throw new Error('gateway request timeout');
}

function refusal(result: { text: string; status: number }): GatewayResponse {
  let reason: string | undefined;
  try {
    const parsed: unknown = JSON.parse(result.text);
    if (parsed && typeof parsed === 'object') {
      const value = (parsed as { error?: unknown }).error;
      reason = typeof value === 'string' && value ? value : undefined;
    }
  } catch {
    // A non-JSON body still names the status below.
  }
  const detail = result.text.trim().slice(0, 200);
  return {
    refused: true,
    httpStatus: result.status,
    error: reason ?? (detail ? `gateway ${result.status}: ${detail}` : `gateway ${result.status}`),
  };
}

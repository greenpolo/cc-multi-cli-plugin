// ---------------------------------------------------------------------------
// The fetch shape the gateway uses for outbound provider requests: narrower
// than the global `fetch` so callers cannot rely on options the gateway does
// not support (no `redirect: 'follow'`, no unbounded body streams).
// ---------------------------------------------------------------------------

interface GatewayFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: Buffer | string | ReadableStream<Uint8Array>;
  /** Node's fetch requires half duplex for streamed request bodies. */
  duplex?: 'half';
  signal: AbortSignal;
  redirect: 'error';
}

export type GatewayFetch = (url: string, init: GatewayFetchInit) => Promise<Response>;

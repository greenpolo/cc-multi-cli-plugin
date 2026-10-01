// The boundary between the gateway's routing and a hosted-API provider (OpenAI, Zen).
// A provider module turns one Claude request into a `PreparedRequest`; the gateway owns
// keepalive, events, failure mapping and the reply, and never builds a provider request.

import type { GatewayFetch } from './fetch.ts';
import type { Emit, MessagesRequest, MessagesResponse } from './messages.ts';

/** The provider rejected or could not renew the credentials; answered as HTTP 401. */
export class ProviderAuthError extends Error {}

/** A non-2xx upstream reply, relayed with its status and `retry-after`. */
export class UpstreamFailure extends Error {
  status: number;
  retryAfter: string | null;
  constructor(status: number, retryAfter: string | null, provider: string, authHelp: string) {
    super(`${provider} returned HTTP ${status}.${status === 401 ? authHelp : ''}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Routing facts a provider reports for one request; never credentials or bodies. */
interface ProviderEvent {
  route: 'openai' | 'openai-request' | 'zen' | 'zen-request';
  agentId?: string | null;
  model?: string;
  effort?: string;
  status?: number;
}

/** What the gateway knows about the request before any provider sees it. */
export interface ProviderRequestInput {
  method?: string;
  pathname: string;
  body: MessagesRequest;
  /** The Claude session the request identifies; empty when the client named none. */
  session: string;
  /** The gateway's own session, for a client that identified none. */
  fallbackSession: string;
  /** The session header exactly as the client sent it. */
  clientSession?: string;
  agentId?: string;
}

export interface PreparedRequest {
  /** How failures name the provider. */
  label: string;
  /** What a 401 adds to the failure text. */
  authHelp: string;
  /** The API the request is billed through, reported on completion. */
  endpoint: string;
  route: 'openai' | 'zen';
  /** The local input estimate; computed on first use, since a streamed reply needs it late. */
  inputTokens(): number;
  /** Model and effort the completion reports in place of the client's request, if known. */
  completion?: { model: string; effort?: string };
  requestEvent(agentId?: string): ProviderEvent;
  failureEvent(status: number, agentId?: string): ProviderEvent;
  send(signal: AbortSignal, fetchImpl: GatewayFetch): Promise<Response>;
  translate(stream: ReadableStream<Uint8Array>, emit: Emit | undefined): Promise<MessagesResponse>;
}

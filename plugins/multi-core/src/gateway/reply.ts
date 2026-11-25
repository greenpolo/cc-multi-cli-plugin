// How a gateway reply and a failure reach Claude Code.

import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import {
  displayFollowUp,
  FollowUpRefused,
  FollowUpUnavailable,
  withoutDisplayTools,
} from './display-rows.ts';
import {
  emitHandback,
  handbackOffered,
  handbackRequestKind,
  recordedReport,
  withHandback,
  withoutHarnessHandback,
} from './harness-handback.ts';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
  ServedReply,
  TerminalEmit,
} from './messages.ts';
import { nativeHarnessErrorStatus } from './native-harness.ts';
import { harnessProvider } from './provider.ts';
import { type PreparedRequest, ProviderAuthError, UpstreamFailure } from './provider-request.ts';
import {
  BadRequest,
  externalModel,
  ForbiddenHost,
  type ProviderRequest,
  RequestTooLarge,
  reason,
  routeOf,
  ThreadUnsupported,
} from './request.ts';

/**
 * What keeps a provider reply's connection alive while it works. A stream sends its
 * headers at once and a `ping` event every 15 s. Claude Code's request timeout only
 * bounds the wait for response headers, and a timed-out request is retried: a run that
 * is still working would then be started again. A non-streamed reply that is still
 * pending after a while therefore sends its headers and keeps the connection alive with
 * leading JSON whitespace, which any JSON parser skips before the message. Replies and
 * failures that come sooner keep their own status; after that point a failure can only
 * be an error body.
 */
export class ReplyKeepAlive {
  jsonStarted = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly res: http.ServerResponse;
  private readonly ping: (type: 'ping') => void;
  private readonly delayMs: number;

  constructor(res: http.ServerResponse, ping: (type: 'ping') => void, delayMs: number) {
    this.res = res;
    this.ping = ping;
    this.delayMs = delayMs;
  }

  startStream(streamed: boolean | undefined) {
    if (this.timer) {
      return;
    }
    if (!streamed) {
      this.keepAlive(streamed);
      return;
    }
    this.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    this.res.flushHeaders();
    this.timer = setInterval(() => this.ping('ping'), 15000);
  }

  keepAlive(streamed: boolean | undefined) {
    if (this.timer || streamed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.jsonStarted = true;
      this.res.writeHead(200, { 'content-type': 'application/json' });
      this.res.flushHeaders();
      this.timer = setInterval(() => this.res.write(' '), Math.min(15000, this.delayMs));
    }, this.delayMs);
  }

  stop() {
    clearInterval(this.timer);
  }
}

/**
 * Display rows are Claude Code UI: no provider sees them as tools or history. A
 * request that only answers a reply's rows is marked as that reply's follow-up.
 */
export function displayRowsRemoved(
  url: URL,
  request: { raw: Buffer; parsed: Record<string, unknown>; body: MessagesRequest },
) {
  const harness = harnessProvider(externalModel(request.body.model));
  const deliverHandback = Boolean(harness && handbackOffered(request.body));
  const handbackKind = harness ? handbackRequestKind(request.body) : undefined;
  const followUp = url.pathname === '/v1/messages' ? displayFollowUp(request.body) : undefined;
  const withoutRows = withoutDisplayTools(request.body);
  const body = harness ? withoutHarnessHandback(withoutRows) : withoutRows;
  const raw = body === request.body ? request.raw : Buffer.from(JSON.stringify(body));
  return { body, raw, followUp, deliverHandback, handbackKind };
}

export function emitTerminal(emit: TerminalEmit, response: ServedReply): void {
  emit('message_delta', {
    delta: {
      stop_reason: response.stop_reason,
      stop_sequence: response.stop_sequence,
      ...(response.safeguard_results === undefined
        ? {}
        : { safeguard_results: response.safeguard_results }),
    },
    usage: response.usage,
  });
  emit('message_stop', {});
}

export function finishHarnessDelivery(
  nativeResult: MessagesResponse,
  deliverHandback: boolean,
  body: MessagesRequest,
  emit: Emit,
): MessagesResponse {
  if (!deliverHandback) {
    return nativeResult;
  }
  const result =
    nativeResult.multi_followup === undefined
      ? withHandback(nativeResult, recordedReport(nativeResult) ?? '')
      : nativeResult;
  if (body.stream) {
    if (result !== nativeResult) {
      emitHandback(emit, result);
    }
  }
  return result;
}

function errorStatus(error: unknown): number {
  if (error instanceof ProviderAuthError) {
    return 401;
  }
  if (error instanceof BadRequest) {
    return 400;
  }
  if (error instanceof FollowUpRefused || error instanceof ForbiddenHost) {
    return 403;
  }
  if (error instanceof FollowUpUnavailable) {
    // Not 404: Claude Code renders any 404 as "model not found", hiding this message.
    // 410 is not retried by Claude Code and shows the message as written.
    return 410;
  }
  if (error instanceof UpstreamFailure) {
    return error.status;
  }
  const harnessStatus = nativeHarnessErrorStatus(error);
  if (harnessStatus !== undefined) {
    return harnessStatus;
  }
  return 502;
}

export function sendResult(exchange: ProviderRequest, result: ServedReply) {
  if (!exchange.body.stream && !exchange.res.headersSent) {
    exchange.res.writeHead(200, { 'content-type': 'application/json' });
  }
  exchange.res.end(exchange.body.stream ? undefined : JSON.stringify(result));
}

export function failResponse(res: http.ServerResponse, emit: TerminalEmit, error: unknown) {
  if (res.destroyed) {
    return;
  }
  const status = errorStatus(error);
  if (error instanceof RequestTooLarge) {
    // Anthropic's own 413 body, so Claude Code reads it as it would natively.
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'request_too_large',
          message: 'Request exceeds the maximum allowed number of bytes.',
        },
      }),
    );
    return;
  }
  const errorTypes: Record<number, string> = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    403: 'permission_error',
    404: 'not_found_error',
    429: 'rate_limit_error',
    503: 'overloaded_error',
  };
  const failure = {
    type: 'error',
    error: {
      type: errorTypes[status] ?? 'api_error',
      message: `Native gateway: ${latchSafe(reason(error))}`,
      // Anthropic's error shape, which Claude Code reads to drop the thread (see request.ts).
      ...(error instanceof ThreadUnsupported ? { details: { error_code: error.errorCode } } : {}),
    },
  };
  if (error instanceof UpstreamFailure && error.retryAfter && !res.headersSent) {
    res.setHeader('retry-after', error.retryAfter);
  }
  if (res.headersSent) {
    emit('error', { error: failure.error });
    res.end();
  } else {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failure));
  }
}

/** The failure as an ordinary assistant message: it states the failure and claims no work. */
export function failureMessage(error: unknown, model: string): MessagesResponse {
  const provider = routeOf(model);
  const detail = latchSafe(reason(error)).replace(/\s+/g, ' ').trim().slice(0, 500);
  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: `Multi: ${provider} failed: ${detail}` }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function latchSafe(text: string): string {
  return text.replace(/safeguards|dangerous-tool-use|beta/gi, 'verdict');
}

/** Upstream error bodies are short JSON; a provider explanation never needs more. */
const MAX_FAILURE_BODY_BYTES = 16 * 1024;

/** The provider's fixed explanation for a failure body, read bounded and never logged. */
export async function explainUpstreamFailure(
  prepared: PreparedRequest,
  upstream: Response,
): Promise<string | undefined> {
  if (!(prepared.explainFailure && upstream.body)) {
    await upstream.body?.cancel();
    return undefined;
  }
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_FAILURE_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const text = Buffer.concat(chunks).subarray(0, MAX_FAILURE_BODY_BYTES).toString('utf8');
  return prepared.explainFailure(upstream.status, text);
}

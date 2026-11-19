// Claude's own traffic: the headers and paths the gateway passes through to Anthropic.

import type http from 'node:http';
import { header } from './request.ts';

export const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com';

const STRIPPED_REQUEST_HEADERS = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'x-multi-gateway-token',
  'accept-encoding',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
  'proxy-authorization',
];

export const STRIPPED_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
];

/**
 * Everything except the Messages API the gateway parses and may route, and its own
 * /multi/* control routes, goes to Anthropic as raw bytes with the caller's headers.
 */
export function isRawAnthropicPath(pathName: string) {
  return (
    !pathName.startsWith('/multi/') &&
    !['/v1/messages', '/v1/messages/count_tokens'].includes(pathName)
  );
}

/** The origin and path prefix Claude's traffic is forwarded to, without a trailing slash. */
export function parseAnthropicBase(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The Anthropic base URL must be http or https');
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

export function anthropicHeaders(req: http.IncomingMessage) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const single = header(value);
    if (single !== undefined && !STRIPPED_REQUEST_HEADERS.includes(name)) {
      headers[name] = single;
    }
  }
  headers['accept-encoding'] = decodableEncodings(req.headers['accept-encoding']);
  return headers;
}

/**
 * Node's fetch decodes gzip, deflate and br before the gateway sees a byte, so the
 * observer and the relay always handle decoded bytes (the relay drops content-encoding
 * and content-length). Keep the client's own preference for those, so Anthropic
 * compresses as it would for Claude Code directly; anything else asks for identity.
 */
function decodableEncodings(value: string | string[] | undefined) {
  const wanted = (header(value) ?? '')
    .split(',')
    .map((entry) => entry.trim().split(';')[0].toLowerCase())
    .filter((entry) => ['gzip', 'deflate', 'br'].includes(entry));
  return wanted.length ? wanted.join(', ') : 'identity';
}

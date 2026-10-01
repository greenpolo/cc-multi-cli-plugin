import { createHash } from 'node:crypto';
import type { GatewayFetch } from '../../multi-core/src/gateway/fetch.ts';
import type {
  PreparedRequest,
  ProviderRequestInput,
} from '../../multi-core/src/gateway/provider-request.ts';
import { fromResponses } from '../../multi-core/src/gateway/responses.ts';
import { originalToolNames } from '../../multi-core/src/gateway/tools.ts';
import { fromChat, ZEN_SIGNATURE_PREFIXES } from './chat.ts';
import { zenRequest } from './request.ts';

const ZEN_URL = 'https://opencode.ai/zen/v1';
const MESSAGES_PATHS = ['/v1/messages', '/v1/messages/count_tokens'];

export const zenUnavailable =
  'Zen is not configured. Set OPENCODE_API_KEY or connect OpenCode Zen.';

/** The prefixes of the reasoning signatures this provider writes into Claude's history. */
export const zenSignaturePrefixes: readonly string[] = ZEN_SIGNATURE_PREFIXES;

const zenAuthHelp = ' Check the Zen API key.';

/** The Zen request for one Claude request to a `multi/zen/` model. */
export function prepareZenRequest(
  { method, pathname, body, session, fallbackSession, agentId }: ProviderRequestInput,
  apiKey: string,
): PreparedRequest {
  if (method !== 'POST' || !MESSAGES_PATHS.includes(pathname)) {
    throw new Error('Zen requires POST /v1/messages or /v1/messages/count_tokens');
  }
  // Zen uses this for sticky upstream routing. Claude identity survives restarts;
  // no per-request nonce is inserted into the prompt or cache key.
  const cacheKey = createHash('sha256')
    .update(
      JSON.stringify([session || fallbackSession, agentId ?? 'main', body.model, process.cwd()]),
    )
    .digest('hex');
  const prepared = zenRequest(body, cacheKey);
  return {
    label: 'Zen',
    authHelp: zenAuthHelp,
    endpoint: prepared.endpoint,
    route: 'zen',
    inputTokens: () => prepared.inputTokens,
    requestEvent: (agent) => ({ route: 'zen-request', agentId: agent, model: body.model }),
    failureEvent: (status, agent) => ({ route: 'zen', agentId: agent, status }),
    send: (signal: AbortSignal, fetchImpl: GatewayFetch) =>
      fetchImpl(`${ZEN_URL}/${prepared.endpoint}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-opencode-session': cacheKey,
          'x-opencode-client': 'cc-multi-cli-plugin',
        },
        body: JSON.stringify(prepared.body),
        signal,
        redirect: 'error',
      }),
    translate: (stream, emit) => {
      const options = {
        toolNames: originalToolNames(body),
        stopSequences: body.stop_sequences,
        signaturePrefix: prepared.signaturePrefix,
        requireUsage: true,
        inputTokens: prepared.inputTokens,
        safeguards: body.safeguards,
        safeguardProvider: 'zen' as const,
      };
      const translate = prepared.endpoint === 'responses' ? fromResponses : fromChat;
      return translate(stream, String(body.model), emit, options);
    },
  };
}

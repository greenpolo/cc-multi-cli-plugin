import { createHash } from 'node:crypto';
import type { GatewayFetch } from '../../multi-core/src/gateway/fetch.ts';
import type {
  PreparedRequest,
  ProviderRequestInput,
} from '../../multi-core/src/gateway/provider-request.ts';
import { ProviderAuthError } from '../../multi-core/src/gateway/provider-request.ts';
import { estimateInputTokens } from '../../multi-core/src/gateway/tokens.ts';
import { originalToolNames } from '../../multi-core/src/gateway/tools.ts';
import { CodexAuthError, codexRequest } from './auth.ts';
import { openaiInstructions } from './instructions.ts';
import { MODELS } from './models.ts';
import { fromResponses, toResponses } from './responses.ts';

const OPENAI_URL = 'https://chatgpt.com/backend-api/codex/responses';
const MESSAGES_PATHS = ['/v1/messages', '/v1/messages/count_tokens'];

const openaiAuthHelp = ' Renew the Codex login.';

/** The Responses request for one Claude request to a native `multi/openai/` model. */
export function prepareOpenAIRequest(
  {
    method,
    pathname,
    body,
    session,
    fallbackSession,
    clientSession,
    agentId,
  }: ProviderRequestInput,
  externalModel: string,
  authFile: string,
): PreparedRequest {
  const model = Object.values(MODELS).find((model) => externalModel === `multi/openai/${model}`);
  if (!model) {
    throw new Error('Unknown native OpenAI model');
  }
  if (!MESSAGES_PATHS.includes(pathname) || method !== 'POST') {
    throw new Error('External models require POST /v1/messages or /v1/messages/count_tokens');
  }
  const translated = toResponses(body, model);
  const request = {
    ...translated,
    instructions: openaiInstructions(translated.instructions),
    prompt_cache_key: createHash('sha256')
      .update(
        JSON.stringify(['openai', session || fallbackSession, agentId ?? 'main', translated.model]),
      )
      .digest('hex'),
  };
  let estimate: number | undefined;
  const inputTokens = () => {
    estimate ??= estimateInputTokens(request);
    return estimate;
  };
  let toolNames: Map<string, string> | undefined;
  return {
    label: 'OpenAI',
    authHelp: openaiAuthHelp,
    endpoint: 'responses',
    route: 'openai',
    inputTokens,
    completion: { model: request.model, effort: request.reasoning.effort },
    requestEvent: (agent) => ({
      route: 'openai-request',
      agentId: agent,
      model: request.model,
      effort: request.reasoning.effort,
    }),
    failureEvent: (status) => ({ route: 'openai', status }),
    async send(signal: AbortSignal, fetchImpl: GatewayFetch) {
      toolNames = originalToolNames(body);
      const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        originator: 'cc_multi_native',
        session_id: String(agentId ?? clientSession ?? fallbackSession),
      };
      try {
        return await codexRequest(authFile, signal, (auth) =>
          fetchImpl(OPENAI_URL, {
            method: 'POST',
            headers: { ...headers, ...auth },
            body: JSON.stringify(request),
            signal,
            redirect: 'error',
          }),
        );
      } catch (error) {
        throw error instanceof CodexAuthError ? new ProviderAuthError(error.message) : error;
      }
    },
    translate: (stream, emit) =>
      fromResponses(stream, externalModel, emit, {
        toolNames: toolNames ?? originalToolNames(body),
        stopSequences: body.stop_sequences,
        inputTokens: inputTokens(),
        safeguards: body.safeguards,
      }),
  };
}

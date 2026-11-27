import { createHash } from 'node:crypto';
import type { GatewayFetch } from '../../multi-core/src/gateway/fetch.ts';
import type {
  PreparedRequest,
  ProviderRequestInput,
} from '../../multi-core/src/gateway/provider-request.ts';
import { ProviderAuthError } from '../../multi-core/src/gateway/provider-request.ts';
import { isRecord } from '../../multi-core/src/gateway/record.ts';
import {
  fromResponses,
  OPENAI_SIGNATURE_PREFIX,
  toResponses,
} from '../../multi-core/src/gateway/responses.ts';
import { estimateInputTokens } from '../../multi-core/src/gateway/tokens.ts';
import { originalToolNames } from '../../multi-core/src/gateway/tools.ts';
import { CodexAuthError, codexRequest } from './auth.ts';
import { openaiInstructions } from './instructions.ts';
import { MODELS } from './models.ts';

const OPENAI_URL = 'https://chatgpt.com/backend-api/codex/responses';
const MESSAGES_PATHS = ['/v1/messages', '/v1/messages/count_tokens'];

/** The prefixes of the reasoning signatures this provider writes into Claude's history. */
export const openaiSignaturePrefixes: readonly string[] = [OPENAI_SIGNATURE_PREFIX];

const openaiAuthHelp = ' Renew the Codex login.';

/**
 * OpenAI's own words for a refused request. A spent plan window says when it
 * resets, as the Codex CLI does, so Claude Code does not show a generic rate limit.
 */
function explainOpenAIFailure(status: number, body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  if (!error) {
    return undefined;
  }
  if (error.type === 'usage_limit_reached' || (status === 429 && 'resets_at' in error)) {
    const plan = typeof error.plan_type === 'string' ? ` on the ${error.plan_type} plan` : '';
    return `OpenAI: you've hit your Codex usage limit${plan}.${resetsAt(error)}`;
  }
  return typeof error.message === 'string' && error.message.trim()
    ? `OpenAI returned HTTP ${status}: ${error.message.replace(/\s+/g, ' ').trim().slice(0, 300)}`
    : undefined;
}

function resetsAt(error: Record<string, unknown>): string {
  let seconds: number | undefined;
  if (typeof error.resets_at === 'number') {
    seconds = error.resets_at;
  } else if (typeof error.resets_in_seconds === 'number') {
    seconds = Date.now() / 1000 + error.resets_in_seconds;
  }
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return '';
  }
  const when = new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return ` Try again at ${when}.`;
}

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
    explainFailure: explainOpenAIFailure,
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
    translate: (stream, emit, rememberWorkerModel) =>
      fromResponses(stream, externalModel, emit, {
        rememberWorkerModel,
        toolNames: toolNames ?? originalToolNames(body),
        stopSequences: body.stop_sequences,
        inputTokens: inputTokens(),
      }),
  };
}

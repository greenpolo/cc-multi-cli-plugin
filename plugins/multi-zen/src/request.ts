import type { MessagesRequest } from '../../multi-core/src/gateway/messages.ts';
import type {
  ResponsesInputContent,
  ResponsesRequest,
} from '../../multi-core/src/gateway/responses.ts';
import { toResponses } from '../../multi-core/src/gateway/responses.ts';
import { estimateInputTokens, estimateTextTokens } from '../../multi-core/src/gateway/tokens.ts';
import { toChat, ZEN_RESPONSES_SIGNATURE_PREFIX } from './chat.ts';
import type { ZenModel } from './models.ts';
import { zenModel } from './models.ts';

function validateMedia(request: ResponsesRequest, model: ZenModel) {
  const check = (part: ResponsesInputContent) => {
    if (part.type === 'input_image' && !model.images) {
      throw new Error(`${model.id} does not support images in this integration`);
    }
    if (part.type === 'input_file' && !model.documents) {
      throw new Error(`${model.id} does not support PDF attachments in this integration`);
    }
  };
  for (const item of request.input) {
    if ('role' in item) {
      for (const part of item.content) {
        check(part);
      }
    } else if (item.type === 'function_call_output' && Array.isArray(item.output)) {
      for (const part of item.output) {
        check(part);
      }
    }
  }
}

/** Pure translation keeps repeated prefixes byte-stable; the caller owns credentials. */
export function zenRequest(body: MessagesRequest, cacheKey: string) {
  const model = zenModel(body.model?.replace(/^multi\/zen\//, '') ?? '');
  if (!model || body.model !== `multi/zen/${model.id}`) {
    throw new Error('Unknown Zen model. Run the launcher with --zen-models for supported choices.');
  }
  if (
    body.max_tokens !== undefined &&
    (!Number.isSafeInteger(body.max_tokens) ||
      body.max_tokens < 1 ||
      body.max_tokens > model.maxOutputTokens)
  ) {
    throw new Error(`Zen max_tokens must be between 1 and ${model.maxOutputTokens}`);
  }
  const signaturePrefix = `${ZEN_RESPONSES_SIGNATURE_PREFIX}${model.id}:`;
  const normalized = toResponses(body, model.id, signaturePrefix);
  validateMedia(normalized, model);
  const effort = body.output_config?.effort;
  if (effort !== undefined && model.efforts && !model.efforts.some((value) => value === effort)) {
    throw new Error(
      `${model.id} does not support effort ${effort}. Reset /effort to auto to use its native default.`,
    );
  }
  const common = { signaturePrefix, inputTokens: estimateInputTokens(normalized) };
  if (model.protocol === 'chat') {
    // Claude supplies an effort even for models with no adjustable effort. These
    // catalog entries explicitly use native reasoning, with no effort presets.
    const chat = toChat({ ...body, max_tokens: body.max_tokens ?? 32000 }, model.id);
    const reasoningTokens = chat.messages.reduce(
      (total, message) =>
        total +
        ('reasoning_content' in message ? estimateTextTokens(message.reasoning_content ?? '') : 0),
      0,
    );
    return {
      ...common,
      inputTokens: common.inputTokens + reasoningTokens,
      endpoint: 'chat/completions' as const,
      body: chat,
    };
  }
  return {
    ...common,
    endpoint: 'responses' as const,
    body: {
      ...normalized,
      max_output_tokens: body.max_tokens ?? Math.min(32000, model.maxOutputTokens),
      prompt_cache_key: cacheKey,
    },
  };
}

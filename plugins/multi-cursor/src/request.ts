import type { SDKUserMessage } from '@cursor/sdk';
import type { MessagesRequest } from '../../multi-core/src/gateway/messages.ts';
import { estimateTextTokens } from '../../multi-core/src/gateway/tokens.ts';
import { toResponses } from '../../multi-openai/src/responses.ts';

function validateControls(body: MessagesRequest) {
  if (
    body.output_config != null &&
    (typeof body.output_config !== 'object' || Array.isArray(body.output_config))
  ) {
    throw new Error('Invalid output_config');
  }
  if (body.output_config?.effort !== undefined && typeof body.output_config.effort !== 'string') {
    throw new Error('Invalid effort');
  }
  if (body.tool_choice && !['auto', 'none'].includes(body.tool_choice.type)) {
    throw new Error('Native Cursor supports automatic tools; forced tool choice is unavailable');
  }
  if (body.tool_choice?.type === 'none') {
    throw new Error('Native Cursor cannot enforce per-request tool_choice none');
  }
  if (body.output_config?.format || body.output_format) {
    throw new Error('Cursor SDK does not support a strict Messages output schema');
  }
  if (body.stop_sequences?.length) {
    throw new Error('Cursor SDK does not support Messages stop sequences');
  }
}

export function prepareCursorRequest(body: MessagesRequest) {
  validateControls(body);
  // AgentOptions has no Messages max-token or sampling controls. Keep Claude's
  // required max_tokens accepted, but do not claim the SDK enforces it or samples.
  // Reuse the existing validated Messages parser and media normalization. This
  // normalized representation is only local data; no OpenAI request is made.
  const normalized = toResponses({ ...body, output_config: { effort: 'medium' } }, 'cursor');
  if (
    normalized.input.some(
      (item) =>
        ('content' in item && item.content.some((c) => c.type === 'input_file')) ||
        ('type' in item &&
          item.type === 'function_call_output' &&
          Array.isArray(item.output) &&
          item.output.some((c) => c.type === 'input_file')),
    )
  ) {
    throw new Error('Cursor SDK does not support PDF attachments; provide extracted text');
  }
  const images: NonNullable<SDKUserMessage['images']> = [];
  const input = JSON.parse(
    JSON.stringify(
      normalized.input.filter((item) => !('type' in item) || item.type !== 'reasoning'),
    ),
    (_key, value) => {
      if (value?.type === 'input_image') {
        if (value.image_url.startsWith('data:')) {
          const [prefix, data] = value.image_url.split(',');
          images.push({ data, mimeType: prefix.slice(5).split(';')[0] });
        } else {
          images.push({ url: value.image_url });
        }
        return { type: 'text', text: `[Attached image ${images.length}]` };
      }
      return value;
    },
  );
  const prompt: SDKUserMessage = {
    text: [
      'You are the Cursor coding agent displayed inside Claude Code. Use your native tools and permissions.',
      'The supplied conversation is context. Previously recorded actions are complete; never repeat them to reconstruct state.',
      'Continue after the final message.',
      JSON.stringify({ conversation: input }),
    ].join('\n'),
    ...(images.length ? { images } : {}),
  };
  // ponytail: SDK hidden envelope overhead and image expansion are unknown;
  // estimate the submitted prompt until SDK exposes context counting.
  const inputTokens = estimateTextTokens(prompt.text ?? '') + images.length * 4096;
  return { prompt, inputTokens };
}

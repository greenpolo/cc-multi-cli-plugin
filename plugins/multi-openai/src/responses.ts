import type { MessagesRequest } from '../../multi-core/src/gateway/messages.ts';
import {
  OPENAI_SIGNATURE_PREFIX,
  forAnthropic as stripProviderSignatures,
} from '../../multi-core/src/gateway/responses.ts';
import { ZEN_SIGNATURE_PREFIXES } from '../../multi-zen/src/chat.ts';

export {
  fromResponses,
  type ResponsesRequest,
  toResponses,
} from '../../multi-core/src/gateway/responses.ts';

/**
 * Compatibility entry for the gateway router, which still imports this module.
 * The gateway owns the provider list; the shared translation takes it as a parameter.
 */
export function forAnthropic(body: MessagesRequest): MessagesRequest {
  return stripProviderSignatures(body, [OPENAI_SIGNATURE_PREFIX, ...ZEN_SIGNATURE_PREFIXES]);
}

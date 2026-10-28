import type { Effort } from '../../multi-core/src/gateway/responses.ts';

export const MODELS = {
  'openai-sol': 'gpt-6.1-sol',
  'openai-astra': 'gpt-6-astra',
  'openai-terra': 'gpt-6.1-terra',
  'openai-luna': 'gpt-6-luna',
};

/** The model a `multi-openai` worker runs when the Agent call names none. */
export const OPENAI_DEFAULT_WORKER_MODEL = MODELS['openai-sol'];

/** The effort every OpenAI worker runs at: a type carries one, never a name variant. */
export const OPENAI_WORKER_EFFORT: Effort = 'medium';

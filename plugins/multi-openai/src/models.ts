import type { Effort } from './responses.ts';

export const MODELS = {
  'openai-native': 'gpt-6-astra',
  'openai-sol': 'gpt-6-sol',
  'openai-terra': 'gpt-5.6-terra',
  'openai-luna': 'gpt-6-luna',
};

/** The model a `multi-openai` worker runs when the Agent call names none. */
export const OPENAI_DEFAULT_WORKER_MODEL = MODELS['openai-native'];

/** The effort every OpenAI worker runs at: a type carries one, never a name variant. */
export const OPENAI_WORKER_EFFORT: Effort = 'medium';

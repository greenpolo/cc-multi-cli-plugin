import type { Effort } from './responses.ts';

export const MODELS = {
  'openai-native': 'gpt-6-astra',
  'openai-sol': 'gpt-6-sol',
  'openai-terra': 'gpt-5.6-terra',
  'openai-luna': 'gpt-6-luna',
};

/** A registered native worker: the OpenAI model it runs on and its reasoning effort. */
export interface Worker {
  model: string;
  effort: Effort;
}

export const OPENAI_WORKERS: Readonly<Record<string, Worker>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MODELS).flatMap(([name, model]) =>
      (['', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((level) => [
        level ? `${name}-${level}` : name,
        { model, effort: level || 'medium' },
      ]),
    ),
  ),
);

import type { Effort } from '../../multi-openai/src/responses.ts';

type ZenProtocol = 'responses' | 'chat';

export interface ZenModel {
  id: string;
  protocol: ZenProtocol;
  label: string;
  description: string;
  efforts?: readonly Effort[];
  images: boolean;
  documents: boolean;
  maxOutputTokens: number;
}

export interface ZenModelOption extends ZenModel {
  model: string;
  worker: string;
  nativeWorker: true;
}

export interface ZenWorker {
  model: string;
  effort?: Effort;
}

const GPT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Effort[];

// Bounded catalog from OpenCode's models.dev snapshot:
// github.com/anomalyco/opencode/blob/830d5eb5354874105cc31599635a80c1662609e8/packages/opencode/test/tool/fixtures/models-api.json
// Zen's /models endpoint exposes IDs only, so capabilities stay explicit and conservative.
export const ZEN_MODELS: readonly ZenModel[] = Object.freeze([
  {
    id: 'gpt-6-luna',
    protocol: 'responses',
    label: 'GPT-6 Luna',
    description: 'OpenCode Zen · GPT Responses',
    efforts: GPT_EFFORTS,
    images: true,
    documents: true,
    maxOutputTokens: 128000,
  },
  {
    id: 'gpt-6-sol',
    protocol: 'responses',
    label: 'GPT-6 Sol',
    description: 'OpenCode Zen · GPT Responses',
    efforts: GPT_EFFORTS,
    images: true,
    documents: true,
    maxOutputTokens: 128000,
  },
  {
    id: 'gpt-5.6-luna',
    protocol: 'responses',
    label: 'GPT-5.6 Luna',
    description: 'OpenCode Zen · GPT Responses',
    efforts: GPT_EFFORTS,
    images: true,
    documents: true,
    maxOutputTokens: 128000,
  },
  {
    id: 'gpt-5.6-terra',
    protocol: 'responses',
    label: 'GPT-5.6 Terra',
    description: 'OpenCode Zen · GPT Responses',
    efforts: GPT_EFFORTS,
    images: true,
    documents: true,
    maxOutputTokens: 128000,
  },
  {
    id: 'gpt-5.6-sol',
    protocol: 'responses',
    label: 'GPT-5.6 Sol',
    description: 'OpenCode Zen · GPT Responses',
    efforts: GPT_EFFORTS,
    images: true,
    documents: true,
    maxOutputTokens: 128000,
  },
  {
    id: 'glm-5.2',
    protocol: 'chat',
    label: 'GLM-5.2',
    description: 'OpenCode Zen · Chat Completions',
    images: false,
    documents: false,
    maxOutputTokens: 131072,
  },
  {
    id: 'minimax-m2.7',
    protocol: 'chat',
    label: 'MiniMax-M2.7',
    description: 'OpenCode Zen · Chat Completions',
    images: false,
    documents: false,
    maxOutputTokens: 131072,
  },
  // Zen /v1/models still lists retired IDs (deepseek-v4-pro, kimi-k2.7-code) that
  // answer 404, and free-tier IDs that refuse use outside OpenCode; each entry here
  // served a live request on 2026-09-26.
  {
    id: 'deepseek-v4.1-flash',
    protocol: 'chat',
    label: 'DeepSeek V4.1 Flash',
    description: 'OpenCode Zen · Chat Completions',
    images: true,
    documents: false,
    maxOutputTokens: 384000,
  },
  {
    id: 'deepseek-v4-flash',
    protocol: 'chat',
    label: 'DeepSeek V4 Flash',
    description: 'OpenCode Zen · Chat Completions',
    images: false,
    documents: false,
    maxOutputTokens: 384000,
  },
  {
    id: 'kimi-k3',
    protocol: 'chat',
    label: 'Kimi K3',
    description: 'OpenCode Zen · Chat Completions',
    images: true,
    documents: false,
    maxOutputTokens: 131072,
  },
  {
    id: 'glm-5.3',
    protocol: 'chat',
    label: 'GLM-5.3',
    description: 'OpenCode Zen · Chat Completions',
    images: false,
    documents: false,
    maxOutputTokens: 131072,
  },
  {
    id: 'glm-5.3-flash',
    protocol: 'chat',
    label: 'GLM-5.3-Flash',
    description: 'OpenCode Zen · Chat Completions',
    images: true,
    documents: false,
    maxOutputTokens: 131072,
  },
  {
    id: 'muse-spark-1.3',
    protocol: 'responses',
    label: 'Muse Spark 1.3',
    description: 'OpenCode Zen · Responses',
    efforts: GPT_EFFORTS,
    images: true,
    documents: true,
    maxOutputTokens: 131072,
  },
]);

// Curated default picker; other supported models remain explicitly selectable.
const DEFAULT_ZEN_MODELS = [
  'deepseek-v4.1-flash',
  'kimi-k3',
  'glm-5.3',
  'glm-5.3-flash',
  'muse-spark-1.3',
];

const modelById = new Map(ZEN_MODELS.map((model) => [model.id, model]));

function workerName(id: string): string {
  return `zen-${id}`;
}

function route(id: string): string {
  return `multi/zen/${id}`;
}

/** Build picker rows, optionally intersected with a discovered Zen catalog. */
export function zenModelOptions(availableIds?: readonly string[]): ZenModelOption[] {
  const available = availableIds === undefined ? undefined : new Set(availableIds);
  return ZEN_MODELS.filter((model) => available?.has(model.id) ?? true).map((model) => ({
    ...model,
    model: route(model.id),
    worker: workerName(model.id),
    nativeWorker: true,
  }));
}

export const ZEN_WORKERS: Readonly<Record<string, ZenWorker>> = Object.freeze(
  Object.fromEntries(
    ZEN_MODELS.flatMap((model) => {
      const base = [
        [workerName(model.id), { model: route(model.id), effort: defaultEffort(model) }],
      ];
      const efforts = (model.efforts ?? []).map((effort) => [
        `${workerName(model.id)}-${effort}`,
        { model: route(model.id), effort },
      ]);
      return [...base, ...efforts];
    }),
  ),
);

function defaultEffort(model: ZenModel): Effort | undefined {
  return model.efforts?.includes('medium') ? 'medium' : undefined;
}

export function zenModel(id: string): ZenModel | undefined {
  return modelById.get(id);
}

/** Restrict Zen rows without hiding subscription providers. */
export function zenPickerOptions(selection: string | undefined): ZenModelOption[] {
  if (selection === undefined) {
    return zenModelOptions(DEFAULT_ZEN_MODELS);
  }
  return [
    ...new Set(
      selection
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ].map((id) => {
    const option = zenModelOptions([id])[0];
    if (!option) {
      throw new Error(`MULTI_ZEN_MODELS: unknown Zen model: ${id}`);
    }
    return option;
  });
}

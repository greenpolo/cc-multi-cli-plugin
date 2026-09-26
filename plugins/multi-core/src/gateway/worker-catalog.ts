/**
 * One Agent-tool type per provider. The Agent tool's `model` parameter names the
 * model; this catalog resolves it against the session's picker rows, the models
 * the person can already select with /model. Effort is never part of a type or a
 * model name: a type carries at most one provider-wide default, and otherwise the
 * request's effort (the session's /effort) applies, validated by the provider.
 */

const WORKER_PROVIDERS = ['openai', 'zen', 'cursor', 'antigravity', 'grok'] as const;
export type WorkerProvider = (typeof WORKER_PROVIDERS)[number];

const PROVIDER_LABELS: Readonly<Record<WorkerProvider, string>> = {
  openai: 'OpenAI',
  zen: 'Zen',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  grok: 'Grok',
};

/** Claude's model aliases: the Agent tool's own values, never a provider model. */
const CLAUDE_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'inherit']);
const EFFORT_SUFFIX = /^(.+)-(low|medium|high|xhigh|max)$/;

interface WorkerModel {
  /** The id the Agent tool's `model` names: `composer-2.5`, `gemini-3.8-flash`. */
  id: string;
  /** The full model the worker runs on, as its picker row spells it. */
  model: string;
}

export interface ProviderWorker {
  type: string;
  provider: WorkerProvider;
  label: string;
  models: WorkerModel[];
  defaultId: string;
  effort?: string;
}

export type WorkerCatalog = Readonly<Record<string, ProviderWorker>>;

export interface ResolvedWorker {
  type: string;
  provider: WorkerProvider;
  label: string;
  id: string;
  model: string;
  effort?: string;
}

export interface WorkerDefaults {
  /** Picks the default id from the provider's ids, in picker order; else the first. */
  defaultId?: (ids: readonly string[]) => string | undefined;
  /** A default every model of the provider accepts, or none. */
  effort?: string;
}

function workerType(provider: WorkerProvider): string {
  return `multi-${provider}`;
}

function providerLabel(provider: WorkerProvider): string {
  return PROVIDER_LABELS[provider];
}

/** `multi/<provider>/<id>` split into its provider and its decoded, untagged id. */
function parseProviderModel(model: string): { provider: WorkerProvider; id: string } | undefined {
  const match = /^multi\/([a-z]+)\/(.+)$/.exec(model);
  const provider = WORKER_PROVIDERS.find((name) => name === match?.[1]);
  if (!match || !provider) {
    return undefined;
  }
  const raw = match[2].replace(/\[1m\]$/i, '');
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    id = raw;
  }
  return { provider, id };
}

/**
 * Group picker rows by provider. A Cursor parameter preset (`multi/cursor/<id>/<params>`)
 * is not a worker model: its parameters, effort among them, are not part of a model name.
 */
export function buildWorkerCatalog(
  rows: readonly { model: string }[],
  defaults: Partial<Record<WorkerProvider, WorkerDefaults>> = {},
): WorkerCatalog {
  const grouped = byProvider(rows);
  const catalog: Record<string, ProviderWorker> = {};
  for (const provider of WORKER_PROVIDERS) {
    const models = withoutEffortVariants(grouped.get(provider));
    const first = models?.[0];
    if (!models || !first) {
      continue;
    }
    const ids = models.map((entry) => entry.id);
    const preferred = defaults[provider]?.defaultId?.(ids);
    const effort = defaults[provider]?.effort;
    catalog[workerType(provider)] = {
      type: workerType(provider),
      provider,
      label: PROVIDER_LABELS[provider],
      models,
      defaultId: preferred && ids.includes(preferred) ? preferred : first.id,
      ...(effort ? { effort } : {}),
    };
  }
  return catalog;
}

function byProvider(rows: readonly { model: string }[]): Map<WorkerProvider, WorkerModel[]> {
  const grouped = new Map<WorkerProvider, WorkerModel[]>();
  for (const { model } of rows) {
    const parsed = parseProviderModel(model);
    if (!parsed || parsed.id.includes('/')) {
      continue;
    }
    const models = grouped.get(parsed.provider) ?? [];
    if (!models.some((entry) => entry.id === parsed.id)) {
      models.push({ id: parsed.id, model });
    }
    grouped.set(parsed.provider, models);
  }
  return grouped;
}

/** A native id that only adds an effort to another listed id (`x-high` beside `x`). */
function withoutEffortVariants(models: WorkerModel[] | undefined): WorkerModel[] | undefined {
  const ids = new Set(models?.map((entry) => entry.id));
  const kept = models?.filter((entry) => {
    const base = EFFORT_SUFFIX.exec(entry.id)?.[1];
    return !(base && ids.has(base));
  });
  return kept?.length ? kept : undefined;
}

/** The short description every model reads in the Agent tool's type listing. */
export function workerDescription(worker: ProviderWorker, runs: string): string {
  const shown = worker.models.slice(0, 4).map((entry) => entry.id);
  const more = worker.models.length > shown.length ? ', ...' : '';
  return `${worker.label} worker (${runs}). Pass model (${shown.join(', ')}${more}) or omit it for ${worker.defaultId}.`;
}

function available(worker: ProviderWorker): string {
  return `${worker.label} models: ${worker.models.map((entry) => entry.id).join(', ')}. Omit model for the default, ${worker.defaultId}.`;
}

function find(worker: ProviderWorker, id: string): WorkerModel | undefined {
  const wanted = id.toLowerCase();
  return worker.models.find((entry) => entry.id.toLowerCase() === wanted);
}

/** Another provider's worker that runs `id`, to name it in the refusal. */
function owner(catalog: WorkerCatalog, id: string, except: string): ProviderWorker | undefined {
  return Object.values(catalog).find((worker) => worker.type !== except && find(worker, id));
}

function refusal(catalog: WorkerCatalog, worker: ProviderWorker, requested: string): string {
  const parsed = parseProviderModel(requested);
  if (parsed && parsed.provider !== worker.provider) {
    const other = catalog[workerType(parsed.provider)];
    const hint = other ? ` Use ${other.type} for it.` : '';
    return `${worker.type} runs ${worker.label} models only; ${requested} belongs to ${providerLabel(parsed.provider)}.${hint} ${available(worker)}`;
  }
  const id = parsed?.id ?? requested;
  if (CLAUDE_ALIASES.has(id.toLowerCase())) {
    return `${worker.type} does not run Claude models; "${id}" is a Claude alias. ${available(worker)}`;
  }
  const variant = EFFORT_SUFFIX.exec(id);
  if (variant && find(worker, variant[1])) {
    return `Effort is not part of a model name: pass model "${variant[1]}". ${available(worker)}`;
  }
  const other = owner(catalog, id, worker.type);
  const hint = other ? ` "${id}" belongs to ${other.type}.` : '';
  return `${worker.type} has no model "${id}".${hint} ${available(worker)}`;
}

/**
 * The model an Agent call runs a provider worker on: its short id, or its full
 * `multi/<provider>/<id>` spelling, or the provider's default when none is given.
 * Anything else fails with the provider's models named.
 */
export function resolveWorker(
  catalog: WorkerCatalog,
  type: string,
  requested?: string,
): ResolvedWorker {
  const worker = Object.hasOwn(catalog, type) ? catalog[type] : undefined;
  if (!worker) {
    throw new Error(`Unknown Multi worker ${type}`);
  }
  const wanted = requested?.trim() || worker.defaultId;
  const parsed = parseProviderModel(wanted);
  const entry =
    parsed?.provider === worker.provider || !parsed
      ? find(worker, parsed?.id ?? wanted)
      : undefined;
  if (!entry) {
    throw new Error(refusal(catalog, worker, wanted));
  }
  return {
    type: worker.type,
    provider: worker.provider,
    label: worker.label,
    id: entry.id,
    model: entry.model,
    ...(worker.effort ? { effort: worker.effort } : {}),
  };
}

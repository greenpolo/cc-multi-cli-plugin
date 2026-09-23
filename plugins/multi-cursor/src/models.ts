import type { ModelListItem, ModelSelection } from '@cursor/sdk';

export interface CursorModelOption {
  model: string;
  label: string;
  description: string;
  selection: ModelSelection;
  catalog: ModelListItem;
}

function defaultParams(item: ModelListItem) {
  const params = item.variants?.find((variant) => variant.isDefault)?.params;
  const standardAvailable =
    item.parameters?.some(
      (parameter) => parameter.id === 'fast' && parameter.values.some((v) => v.value === 'false'),
    ) ||
    item.variants?.some((variant) =>
      variant.params.some((parameter) => parameter.id === 'fast' && parameter.value === 'false'),
    );
  if (standardAvailable) {
    return [
      ...(params ?? []).filter((parameter) => parameter.id !== 'fast'),
      { id: 'fast', value: 'false' },
    ];
  }
  if (params?.some((parameter) => parameter.id === 'fast' && parameter.value === 'true')) {
    throw new Error(`Cursor ${item.id} has no advertised non-Fast default`);
  }
  return params;
}

/** Build advertised selections; missing Router defaults cannot be invented. */
function modelVariants(item: ModelListItem): CursorModelOption[] {
  const variants = item.variants ?? [];
  const baseParams = defaultParams(item);
  const selections = [
    { params: baseParams, label: item.displayName, base: true },
    ...variants.map((variant) => ({
      params: variant.params,
      label: `${item.displayName} · ${variant.displayName}`,
      base: false,
    })),
  ];
  return selections
    .filter(
      ({ params }) =>
        item.id !== 'auto-smart' || params?.some((param) => param.id === 'optimize_for'),
    )
    .map(({ params, label, base }): CursorModelOption => {
      const suffix = params
        ?.map((param) => `${encodeURIComponent(param.id)}=${encodeURIComponent(param.value)}`)
        .sort()
        .join(',');
      const model = `multi/cursor/${encodeURIComponent(item.id)}${!base && suffix ? `/${suffix}` : ''}`;
      const effort = params?.find(
        (param) => param.id === 'effort' || param.id === 'reasoning_effort',
      )?.value;
      return {
        model,
        label: `${label} via Cursor`,
        description: `${label} via Cursor${effort ? ` · ${effort} effort` : ''}`,
        selection: { id: item.id, ...(params?.length ? { params } : {}) },
        catalog: item,
      };
    });
}

/** Only expose models and parameter presets actually advertised to this account. */
export function cursorModelOptions(catalog: ModelListItem[]): CursorModelOption[] {
  const options = new Map<string, CursorModelOption>();
  for (const item of catalog) {
    for (const option of modelVariants(item)) {
      if (options.has(option.model)) {
        continue; // Empty-parameter presets must not replace the base row (notably Auto).
      }
      options.set(option.model, option);
    }
  }
  return [...options.values()];
}

/** The model a `multi-cursor` worker runs when the Agent call names none: Cursor's Auto. */
export const CURSOR_DEFAULT_WORKER_MODEL = 'default';

/** Curated picker lineup; the full catalog stays routable. */
export function cursorPickerOptions(
  options: CursorModelOption[],
  extraModels = '',
): CursorModelOption[] {
  const extras = extraModels
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of extras) {
    if (!options.some((option) => option.model === `multi/cursor/${encodeURIComponent(id)}`)) {
      throw new Error(
        `MULTI_CURSOR_EXTRA_MODELS: model "${id}" is unavailable. Use --cursor-models and choose a selection.id from the account catalog.`,
      );
    }
  }
  return [...new Set([CURSOR_DEFAULT_WORKER_MODEL, 'grok-4.7', 'composer-2.5', ...extras])].flatMap(
    (id) => options.filter((option) => option.model === `multi/cursor/${encodeURIComponent(id)}`),
  );
}

export function cursorSelection(option: CursorModelOption, effort?: string): ModelSelection {
  const parameter = option.catalog.parameters?.find(
    (p) => p.id === 'effort' || p.id === 'reasoning_effort',
  );
  // Explicit presets win; models without an effort parameter have nothing to set.
  if (!effort || !parameter || option.model.split('/').length > 3) {
    return option.selection;
  }
  if (!parameter.values.some((v) => v.value === effort)) {
    throw new Error(
      `Cursor ${option.selection.id} supports ${parameter.id}: ${parameter.values.map((v) => v.value).join(', ')}; received ${effort}`,
    );
  }
  return {
    id: option.selection.id,
    params: [
      ...(option.selection.params ?? []).filter((p) => p.id !== parameter.id),
      { id: parameter.id, value: effort },
    ],
  };
}

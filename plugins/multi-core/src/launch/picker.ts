// The `/model` picker the launched session offers, and the model it starts on.

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeSpelling, providerOf } from '../gateway/provider.ts';
import type { ConnectedProviders } from './providers.ts';

/** One `/model` entry the launched session offers. */
interface ModelOption {
  behavesAs?: string;
  model: string;
  label: string;
  description: string;
}

export interface LaunchSettings {
  modelPicker: { options: ModelOption[] };
  permissions?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function mergeSettings(args: string[], settings: LaunchSettings) {
  // Keep one --settings argument, preserving explicit caller settings and our picker.
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--settings' && !args[i].startsWith('--settings=')) {
      continue;
    }
    const inline = args[i].startsWith('--settings=');
    const value = inline ? args[i].slice(11) : args[i + 1];
    if (!value) {
      throw new Error('--settings requires a JSON object or file');
    }
    const extra = await readSettings(value);
    const picker = settings.modelPicker;
    Object.assign(settings, extra);
    settings.modelPicker = {
      ...picker,
      ...extra.modelPicker,
      options: [...picker.options, ...(extra.modelPicker?.options ?? [])],
    };
    args.splice(i, inline ? 1 : 2);
    i--;
  }
}

export async function initialSelection(
  args: string[],
  settings: LaunchSettings,
  anthropic: boolean,
  providers: ConnectedProviders,
) {
  const savedModel = await savedSelection(args);
  const requested =
    explicitModel(args) ??
    process.env.ANTHROPIC_MODEL ??
    (typeof settings.model === 'string' ? settings.model : savedModel);
  // With no Claude login, start on an available external model instead of Sonnet.
  const options = settings.modelPicker.options;
  const initialModel = retagSelection(requested, options, providers);
  const preferred = new Set(Object.values(providers).map((provider) => provider.fallbackModel));
  const defaultModel =
    process.env.MULTI_MODELS === undefined
      ? options.find((option) => preferred.has(option.model))
      : undefined;
  const fallback = anthropic ? undefined : (defaultModel ?? options[0])?.model;
  const selectedModel = initialModel ?? fallback;
  // Claude is told the model when it would otherwise choose one itself, and when retagging
  // changed the spelling: the selection Claude restores on its own carries no context tag.
  const retagged = initialModel !== requested;
  const passToClaude = selectedModel !== undefined && (initialModel === undefined || retagged);
  return { selectedModel, modelArgument: passToClaude ? selectedModel : undefined };
}

/** The last `--model` the caller spelled, in either form. */
function explicitModel(args: readonly string[]): string | undefined {
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') {
      model = args[i + 1];
    } else if (args[i].startsWith('--model=')) {
      model = args[i].slice(8);
    }
  }
  return model;
}

/** Move a selection onto whichever spelling the picker offers: tagged, or plain once the
 * context tag is switched off. A selection that survives the opt-out keeps its own row. */
function retagSelection(
  model: string | undefined,
  options: readonly ModelOption[],
  providers: ConnectedProviders,
): string | undefined {
  if (model === undefined || options.some((option) => option.model === model)) {
    return model;
  }
  const native = nativeSpelling(model) ?? model;
  const rows = new Set(options.map((option) => option.model));
  const tagged = `${native}[1m]`;
  if (rows.has(tagged)) {
    return tagged;
  }
  if (rows.has(native)) {
    return native;
  }
  // A real model of a provider can still match no row; its provider decides the spelling.
  return providers[providerOf(native) ?? '']?.retag?.(native) ?? model;
}

/** Replace the caller's own `--model`, so a retagged selection cannot be passed twice.
 * This walks the arguments exactly as `explicitModel` does, so both agree on which
 * occurrence is authoritative; rewriting an earlier one would leave the child on the
 * spelling the retag was meant to replace. */
export function applyModelArgument(args: string[], model: string) {
  let index = -1;
  let inline = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') {
      index = i;
      inline = false;
    } else if (args[i].startsWith('--model=')) {
      index = i;
      inline = true;
    }
  }
  if (index === -1) {
    args.push('--model', model);
  } else if (inline) {
    args[index] = `--model=${model}`;
  } else {
    args[index + 1] = model;
  }
}

export function filterPicker(
  settings: LaunchSettings,
  selection: string | undefined,
  defaultModels: readonly string[] = [],
) {
  if (selection === undefined) {
    return;
  }
  if (selection === 'all') {
    return;
  }
  const additive = selection.startsWith('+');
  const models = [
    ...new Set(
      (additive ? `${defaultModels.join(',')},${selection.slice(1)}` : selection)
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
  const available = new Map(settings.modelPicker.options.map((option) => [option.model, option]));
  const chosen = new Set<ModelOption>();
  for (const model of models) {
    // A tagged row stays selectable by its plain provider ID and the reverse: a selection
    // saved while the tag was on must still resolve once MULTI_DISABLE_1M_CONTEXT turns it off.
    const native = nativeSpelling(model) ?? model;
    const option = available.get(model) ?? available.get(`${native}[1m]`) ?? available.get(native);
    if (!option) {
      throw new Error(
        `MULTI_MODELS: model is not available from a connected provider in this launcher's picker: ${model}. Check the full ID with the provider's own models command (see --help), then add it with /multi-core:setup --models <id>.`,
      );
    }
    chosen.add(option);
  }
  settings.modelPicker.options = [...chosen];
}

async function readSettings(value: string) {
  const extra = JSON.parse(
    value.trimStart().startsWith('{') ? value : await readFile(value, 'utf8'),
  );
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new Error('Invalid --settings object');
  }
  return extra;
}

async function savedSelection(args: string[]) {
  let savedModel: string | undefined;
  const sourcesIndex = args.lastIndexOf('--setting-sources');
  const sources = (
    args.findLast((arg) => arg.startsWith('--setting-sources='))?.slice(18) ??
    (sourcesIndex >= 0 ? args[sourcesIndex + 1] : 'user,project,local')
  ).split(',');
  for (const [source, filename] of [
    [
      'user',
      path.join(
        process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
        'settings.json',
      ),
    ],
    ['project', path.join(process.cwd(), '.claude', 'settings.json')],
    ['local', path.join(process.cwd(), '.claude', 'settings.local.json')],
  ] as const) {
    if (!sources.includes(source)) {
      continue;
    }
    try {
      const value = JSON.parse(await readFile(filename, 'utf8'));
      if (typeof value.model === 'string') {
        savedModel = value.model;
      }
    } catch {
      /* Claude handles missing or invalid native settings itself. */
    }
  }
  return savedModel;
}

/** Client compatibility only, not provider equivalence. Both profiles default to 200K
 * in Claude 2.1.267; newer xhigh profiles imply native 1M and are deliberately not used.
 * Provider validation remains authoritative for every requested effort value. */
function pickerProfile(adjustableEffort: boolean): string {
  return adjustableEffort ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';
}

/** Every connected provider's `/model` rows, in provider order. */
export function pickerSettings(providers: ConnectedProviders, fullCatalog = false): LaunchSettings {
  return {
    modelPicker: {
      options: Object.values(providers).flatMap((provider) =>
        provider.rows(fullCatalog).map(({ model, label, description, adjustableEffort }) => ({
          model,
          label,
          description,
          behavesAs: pickerProfile(adjustableEffort),
        })),
      ),
    },
  };
}

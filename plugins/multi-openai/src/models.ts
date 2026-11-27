import { isRecord } from '../../multi-core/src/gateway/record.ts';
import { queryCodex } from './app-server.ts';

const PREFIX = 'multi/openai/';

export interface CodexModel {
  id: string;
  model: string;
  label: string;
  description: string;
  hidden: boolean;
  default: boolean;
  efforts: readonly string[];
}

export interface CodexSelection {
  model: CodexModel;
  effort?: string;
}

/** The model a session starts on when Claude itself is signed out, if Codex lists it. */
const FALLBACK_MODEL = 'gpt-6-luna';

function parseModel(value: unknown): CodexModel | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    return undefined;
  }
  const efforts = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts.flatMap((option) =>
        isRecord(option) && typeof option.reasoningEffort === 'string'
          ? [option.reasoningEffort]
          : [],
      )
    : [];
  return {
    id: value.id,
    model: `${PREFIX}${value.id}`,
    label:
      typeof value.displayName === 'string' && value.displayName ? value.displayName : value.id,
    description: typeof value.description === 'string' ? value.description : '',
    hidden: value.hidden === true,
    default: value.isDefault === true,
    efforts,
  };
}

/**
 * Codex's own sign-in and model catalog, read from a short-lived app-server. A signed-out
 * Codex offers no rows: its catalog is listed even without an account.
 */
export async function discoverCodex(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ signedIn: boolean; models: CodexModel[] }> {
  const [account, list] = await queryCodex(
    [
      { method: 'account/read', params: {} },
      { method: 'model/list', params: { includeHidden: true, limit: 200 } },
    ],
    { env: options.env },
  );
  const signedIn = isRecord(account) && isRecord(account.account);
  const data = isRecord(list) && Array.isArray(list.data) ? list.data : [];
  const models = data.flatMap((entry) => parseModel(entry) ?? []);
  if (!models.length) {
    throw new Error('Codex returned no model catalog; run codex and check /model.');
  }
  return { signedIn, models };
}

/** Codex's own picker: its listed models, or every model when the full catalog is asked for. */
export function codexPickerOptions(models: readonly CodexModel[], fullCatalog: boolean) {
  const shown = models.filter((model) => fullCatalog || !model.hidden);
  return [...shown].sort((left, right) => Number(right.default) - Number(left.default));
}

/** The model an `OpenAI` worker runs when the Agent call names none: Codex's default. */
export function codexDefaultWorkerModel(models: readonly CodexModel[]): string | undefined {
  return (models.find((model) => model.default) ?? models.find((model) => !model.hidden))?.id;
}

export function codexFallbackModel(models: readonly CodexModel[]): string | undefined {
  const id =
    models.find((model) => model.id === FALLBACK_MODEL)?.id ?? codexDefaultWorkerModel(models);
  return id && `${PREFIX}${id}`;
}

export function selectCodexModel(
  models: readonly CodexModel[],
  model: string | undefined,
  effort?: unknown,
): CodexSelection {
  const row = models.find((option) => option.model === model);
  if (!row) {
    throw new Error('Unknown OpenAI model; run codex and check /model for its models.');
  }
  if (effort === undefined) {
    return { model: row };
  }
  if (typeof effort !== 'string' || !row.efforts.includes(effort)) {
    throw new Error(
      `${row.label} does not support effort ${String(effort)} in Codex (it takes ${row.efforts.join(', ') || 'none'}). Reset /effort to auto for its default.`,
    );
  }
  return { model: row, effort };
}

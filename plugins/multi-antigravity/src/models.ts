import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  executableInvocation,
  resolveExecutable,
} from '../../multi-core/src/gateway/executable.ts';
import { antigravityEnvironment } from './cli.ts';

export interface AntigravityModel {
  id: string;
  model: string;
  label: string;
  effort?: 'low' | 'medium' | 'high';
}

export function parseAntigravityModels(output: string): AntigravityModel[] {
  const models = new Map<string, AntigravityModel>();
  for (const line of output.split('\n')) {
    const match = /^([a-z0-9][a-z0-9.-]*)\t([^\t\r\n]+)\r?$/.exec(line);
    if (!match) {
      continue;
    }
    const [, id, label] = match;
    models.set(id, {
      id,
      model: `multi/antigravity/${id}`,
      label: `Antigravity · ${label}`,
    });
  }
  if (!models.size) {
    throw new Error('Antigravity returned no recognized model catalog; run agy models.');
  }
  return [...models.values()];
}

export interface AntigravityModelDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  execFile?: typeof execFile;
  exists?: (filename: string) => boolean;
}

export async function discoverAntigravityModels(
  options: AntigravityModelDiscoveryOptions = {},
): Promise<AntigravityModel[]> {
  const platform = options.platform ?? process.platform;
  const environment = antigravityEnvironment({ ...options.env, NO_COLOR: '1' });
  const invocation = executableInvocation(
    resolveExecutable('agy', {
      platform,
      env: environment,
      configuredPath: options.executable,
      exists: options.exists,
    }),
    ['models'],
    platform,
    environment,
  );
  const { stdout } = await promisify(options.execFile ?? execFile)(
    invocation.command,
    invocation.args,
    {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      env: environment,
      ...invocation.options,
    },
  );
  return parseAntigravityModels(stdout);
}

/** Group only suffix variants with no independently advertised base identity. */
export function antigravityPickerOptions(models: readonly AntigravityModel[]): AntigravityModel[] {
  const nativeIds = new Set(models.map(({ id }) => id));
  const rows = new Map<string, AntigravityModel>();
  for (const option of models) {
    const base = option.id.replace(/-(low|medium|high)$/, '');
    if (base === option.id || nativeIds.has(base)) {
      rows.set(option.id, option);
    } else if (!rows.has(base)) {
      rows.set(base, {
        id: base,
        model: `multi/antigravity/${base}`,
        label: option.label.replace(/(?:\s*[-·]\s*|\s+|\s*\()(low|medium|high)\)?$/i, ''),
      });
    }
  }
  return [...rows.values()];
}

/**
 * The model a `multi-antigravity` worker runs when the Agent call names none: the newest
 * Gemini generation, a Pro model before a Flash of the same version. `agy models` marks no
 * default and lists in its own order, so the version decides.
 */
export function antigravityDefaultWorkerModel(ids: readonly string[]): string | undefined {
  let best: { id: string; rank: number[] } | undefined;
  for (const id of ids) {
    const match = /^gemini-(\d+)(?:\.(\d+))?(?:-|$)/.exec(id);
    if (!match) {
      continue;
    }
    const rank = [Number(match[1]), Number(match[2] ?? 0), id.includes('-pro') ? 1 : 0];
    if (!best || compareRank(rank, best.rank) > 0) {
      best = { id, rank };
    }
  }
  return best?.id;
}

function compareRank(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function defaultVariant(models: readonly AntigravityModel[], base: string) {
  for (const effort of ['medium', 'high', 'low']) {
    const variant = models.find(({ id }) => id === `${base}-${effort}`);
    if (variant) {
      return variant;
    }
  }
  throw new Error('Antigravity base route has no advertised native variant.');
}

/** Claude's 1M-context picker tag; it is display metadata and never a native model ID. */
export function nativeSpelling(model: string | undefined): string | undefined {
  return model?.replace(/\[1m\]$/i, '');
}

/** Resolve advertised variants; let agy validate effort for models without suffixes. */
export function selectAntigravityModel(
  models: readonly AntigravityModel[],
  model: string | undefined,
  effort?: unknown,
): AntigravityModel {
  const requested = nativeSpelling(model);
  const native = models.find((option) => option.model === requested);
  const row =
    native ?? antigravityPickerOptions(models).find((option) => option.model === requested);
  if (!row) {
    throw new Error('Unknown Antigravity model; run agy models for native selections.');
  }
  const selected = native ?? defaultVariant(models, row.id);
  if (effort === undefined) {
    return selected;
  }
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high') {
    throw new Error('Antigravity effort must be an advertised low, medium or high variant.');
  }
  const base = selected.id.replace(/-(low|medium|high)$/, '');
  if (base === selected.id) {
    return { ...selected, effort };
  }
  const variant = models.find((option) => option.id === `${base}-${effort}`);
  if (!variant) {
    throw new Error(`Antigravity model ${selected.id} does not advertise ${effort} effort.`);
  }
  return variant;
}

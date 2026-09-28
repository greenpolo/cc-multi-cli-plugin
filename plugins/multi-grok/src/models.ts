import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  executableInvocation,
  resolveExecutable,
} from '../../multi-core/src/gateway/executable.ts';
import type { Effort } from '../../multi-openai/src/responses.ts';
import { grokEnvironment } from './cli.ts';

/**
 * `grok models` prints a bulleted catalog, one model per line, with the account
 * default marked. Claude's effort scale is a subset of the CLI's: `none` and
 * `minimal` exist natively but have no Claude row, so they are never selectable.
 */
const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Effort[];

const CATALOG_LINE = /^\s*[*-]\s+([a-z0-9][a-z0-9.-]*)(\s+\(default\))?\s*$/;

export interface GrokModel {
  id: string;
  model: string;
  label: string;
  default: boolean;
}

export interface GrokSelection {
  model: GrokModel;
  effort?: Effort;
}

function route(id: string): string {
  return `multi/grok/${id}`;
}

function label(id: string): string {
  const rest = id.replace(/^grok-/, '');
  if (rest === id) {
    return id;
  }
  return `Grok ${rest.replaceAll('-', ' ')}`;
}

export function parseGrokModels(output: string): GrokModel[] {
  const models = new Map<string, GrokModel>();
  for (const line of output.split('\n')) {
    const match = CATALOG_LINE.exec(line.replace(/\r$/, ''));
    if (!match) {
      continue;
    }
    const [, id, marker] = match;
    models.set(id, {
      id,
      model: route(id),
      label: label(id),
      default: Boolean(marker),
    });
  }
  if (!models.size) {
    throw new Error('Grok returned no recognized model catalog; run grok models.');
  }
  return [...models.values()];
}

export interface GrokModelDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  execFile?: typeof execFile;
  exists?: (filename: string) => boolean;
}

export async function discoverGrokModels(
  options: GrokModelDiscoveryOptions = {},
): Promise<GrokModel[]> {
  const platform = options.platform ?? process.platform;
  const environment = grokEnvironment(options.env);
  const invocation = executableInvocation(
    resolveExecutable('grok', {
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
  return parseGrokModels(stdout);
}

/** Restrict Grok rows without hiding the other providers. */
/** The model a `multi-grok` worker runs when the Agent call names none: the CLI's default. */
export function grokDefaultWorkerModel(models: readonly GrokModel[]): string | undefined {
  return models.find((model) => model.default)?.id;
}

export function grokPickerOptions(models: readonly GrokModel[], selection?: string): GrokModel[] {
  if (selection === undefined) {
    return [...models].sort((left, right) => Number(right.default) - Number(left.default));
  }
  const wanted = [
    ...new Set(
      selection
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  return wanted.map((id) => {
    const option = models.find((model) => model.id === id);
    if (!option) {
      throw new Error(`MULTI_GROK_MODELS: unknown Grok model: ${id}`);
    }
    return option;
  });
}

export function selectGrokModel(
  models: readonly GrokModel[],
  model: string | undefined,
  effort?: unknown,
): GrokSelection {
  const row = models.find((option) => option.model === model);
  if (!row) {
    throw new Error('Unknown Grok model; run grok models for native selections.');
  }
  if (effort === undefined) {
    return { model: row };
  }
  const supported = GROK_EFFORTS.find((value) => value === effort);
  if (!supported) {
    throw new Error(
      `Grok does not support effort ${String(effort)}. Reset /effort to auto for its native default.`,
    );
  }
  return { model: row, effort: supported };
}

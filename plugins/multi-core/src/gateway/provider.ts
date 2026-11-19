// The provider table. Each provider folder (`plugins/multi-<name>/`) describes itself in a
// `provider.json` manifest; core reads those and names no provider. Every routing, review,
// signal and execution decision derives from `providerOf`, the one reader of a model ID's
// `multi/<provider>/` prefix.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './record.ts';

export type AutoReviewPolicy = { review: 'reviewer' | 'harness' | 'none'; statement: string };

/** What a provider states about itself, without running any of its code. */
export interface ProviderManifest {
  /** The `<name>` of `multi/<name>/<model>` and of the `multi-<name>` plugin and worker type. */
  name: string;
  /** How rows, workers and refusals name the provider. */
  label: string;
  /** `direct`: Claude Code runs the tools. `harness`: the provider's SDK or CLI does. */
  kind: 'direct' | 'harness';
  /** Position among providers in `/model`, the worker types and the usage pane. */
  order: number;
  /** What runs a worker of this provider, for the Agent type's description. */
  runs: string;
  /** The upstream a harness bills through, reported on its completion events. */
  endpoint?: string;
  /** What a request is told when the provider is not connected in this session. */
  unavailable?: string;
  /** Auto-mode review; `missing` is the statement when a `reviewer` could not be found. */
  review: { mode: AutoReviewPolicy['review']; statement: string; missing?: string };
  usage: { name: string; url?: string; unavailable: string[] };
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseManifest(value: unknown, file: string): ProviderManifest {
  const review = isRecord(value) ? value.review : undefined;
  const usage = isRecord(value) ? value.usage : undefined;
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    !/^[a-z]+$/.test(value.name) ||
    typeof value.label !== 'string' ||
    (value.kind !== 'direct' && value.kind !== 'harness') ||
    typeof value.order !== 'number' ||
    typeof value.runs !== 'string' ||
    !isRecord(review) ||
    !['reviewer', 'harness', 'none'].includes(String(review.mode)) ||
    typeof review.statement !== 'string' ||
    !isRecord(usage) ||
    typeof usage.name !== 'string' ||
    !strings(usage.unavailable)
  ) {
    throw new Error(`Invalid provider manifest ${file}`);
  }
  return value as unknown as ProviderManifest;
}

/** Every `plugins/multi-<name>/provider.json` beside core, in display order. */
export function readProviderManifests(
  pluginsDirectory = fileURLToPath(new URL('../../../', import.meta.url)),
): ProviderManifest[] {
  const manifests: ProviderManifest[] = [];
  for (const entry of readdirSync(pluginsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('multi-')) {
      continue;
    }
    const file = path.join(pluginsDirectory, entry.name, 'provider.json');
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      // A folder without a manifest (core itself) is not a provider.
      continue;
    }
    const manifest = parseManifest(JSON.parse(source), file);
    if (entry.name !== `multi-${manifest.name}`) {
      throw new Error(`Provider manifest ${file} must name its own folder`);
    }
    manifests.push(manifest);
  }
  return manifests.sort((left, right) => left.order - right.order);
}

const MANIFESTS: readonly ProviderManifest[] = readProviderManifests();
const BY_NAME = new Map(MANIFESTS.map((manifest) => [manifest.name, manifest]));

/** Every provider this installation carries, in display order. */
export function providerManifests(): readonly ProviderManifest[] {
  return MANIFESTS;
}

export function providerManifest(name: string | undefined): ProviderManifest | undefined {
  return name === undefined ? undefined : BY_NAME.get(name);
}

/** The folder a provider's code lives in, for loading its adapter. */
export function providerDirectory(name: string): string {
  return fileURLToPath(new URL(`../../../multi-${name}/`, import.meta.url));
}

/** The provider whose `multi/<provider>/` prefix the model carries, if it is a known one. */
export function providerOf(model: unknown): string | undefined {
  if (typeof model !== 'string') {
    return undefined;
  }
  const name = /^multi\/([a-z]+)\//.exec(model)?.[1];
  return name !== undefined && BY_NAME.has(name) ? name : undefined;
}

export function isHarnessProvider(provider: string | undefined): boolean {
  return providerManifest(provider)?.kind === 'harness';
}

/** The native harness that runs the model's actions itself. */
export function harnessProvider(model: unknown): string | undefined {
  const provider = providerOf(model);
  return isHarnessProvider(provider) ? provider : undefined;
}

/** Claude's context tag is display metadata, never part of a native model ID. */
export function nativeSpelling(model: string | undefined): string | undefined {
  return model?.replace(/\[1m\]$/i, '');
}

/** The provider's Auto-mode review as this session can run it. */
export function autoReviewPolicy(provider: string, reviewerAvailable: boolean): AutoReviewPolicy {
  const review = providerManifest(provider)?.review;
  if (!review) {
    return { review: 'none', statement: 'no auto mode: actions run unreviewed' };
  }
  return review.mode === 'reviewer' && !reviewerAvailable
    ? { review: 'none', statement: review.missing ?? review.statement }
    : { review: review.mode, statement: review.statement };
}

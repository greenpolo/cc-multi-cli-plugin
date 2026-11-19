// The contract between core and a provider folder. A provider's `src/adapter.ts` default-exports
// a `ProviderAdapter`; the launcher loads it for every `provider.json` it finds, so adding or
// removing a provider touches that provider's folder and nothing in core.

import { pathToFileURL } from 'node:url';
import type { WorkerPermissions } from './agent-definitions.ts';
import type { NativeHarness } from './native-harness.ts';
import { type ProviderManifest, providerDirectory, providerManifests } from './provider.ts';
import type { PreparedRequest, ProviderRequestInput } from './provider-request.ts';
import type { ProviderUsageReader } from './provider-usage.ts';
import type { AccountReviewer } from './verdicts.ts';

/** One `/model` row a provider offers. */
interface PickerRow {
  model: string;
  label: string;
  description: string;
  /** Whether Claude Code's `/effort` applies to the row. */
  adjustableEffort: boolean;
}

/** What core hands a provider when a session launches. */
interface LaunchContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The session's plugin selection names this provider, rather than leaving it to default. */
  explicit: boolean;
  /** The tool restrictions a native run in `cwd` takes from the user's Claude settings. */
  harnessSettings(cwd: string): Promise<WorkerPermissions>;
}

/** A provider that is signed in and usable in this session. */
export interface ConnectedProvider {
  /** The provider's `/model` rows: the curated defaults, or its whole catalog. */
  rows(fullCatalog: boolean): PickerRow[];
  /** How a worker type picks its model and effort when the Agent call names none. */
  worker?: { defaultId?: (ids: readonly string[]) => string | undefined; effort?: string };
  /** The model a session starts on when Claude itself is signed out. */
  fallbackModel?: string;
  /** Respell a model of this provider that matches no row (a context tag, say). */
  retag?(nativeModel: string): string;
  /** `harness` providers: what runs a request, and the native tool names it can announce. */
  harness?: NativeHarness & { close(): Promise<void> };
  displayTools?: readonly string[];
  /** `direct` providers: turn one Claude request into the provider's own. */
  prepare?(input: ProviderRequestInput, model: string): PreparedRequest;
  /** `harness` providers: extra judgement of Claude's tool rules; throws to refuse. */
  checkRules?: (rules: string[] | undefined) => void;
  /** The account reviewer for Auto mode, when the manifest declares one and it was found. */
  reviewer?: AccountReviewer;
  usage?: ProviderUsageReader;
  /** Billed usage per native agent, for the usage pane; `scope` says what it covers. */
  billed?: { scope: string; read(session: string): Promise<unknown> };
}

/** A launcher flag a provider owns, such as `--cursor-login`. */
interface ProviderCommand {
  help: string;
  run(): Promise<void>;
}

/** What `multi login <provider>` or `multi connect <provider>` runs. */
interface AccountTools {
  /** Run a command attached to the terminal; resolves with its exit code. */
  run(command: string, args: string[]): Promise<number>;
  /** Run this launcher with one of the provider's own flags. */
  launcher(flag: string): Promise<number>;
}

export interface ProviderAdapter {
  /** Sign-in state, models and runtime for this launch; undefined when not usable. */
  connect(context: LaunchContext): Promise<ConnectedProvider | undefined>;
  /**
   * Prefixes of the reasoning signatures this provider writes into Claude's history. Static,
   * so another provider's request strips them even when this one is not connected.
   */
  signaturePrefixes?: readonly string[];
  /** Launcher flags, keyed by the flag itself. */
  commands?: Readonly<Record<string, ProviderCommand>>;
  /** Environment variables the provider reads, for `--help`. */
  environment?: Readonly<Record<string, string>>;
  /** The account verb the provider answers to, and what it does. */
  account?: {
    verb: 'login' | 'connect';
    run(args: string[], tools: AccountTools): Promise<number>;
  };
}

export interface LoadedProvider {
  manifest: ProviderManifest;
  adapter: ProviderAdapter;
}

function isAdapter(value: unknown): value is ProviderAdapter {
  return (
    typeof value === 'object' &&
    value !== null &&
    'connect' in value &&
    typeof value.connect === 'function'
  );
}

/** Load one provider's adapter from its own folder. */
export async function loadProvider(manifest: ProviderManifest): Promise<LoadedProvider> {
  const file = `${providerDirectory(manifest.name)}src/adapter.ts`;
  const module: { default?: unknown } = await import(pathToFileURL(file).href);
  if (!isAdapter(module.default)) {
    throw new Error(`${file} must default-export a provider adapter`);
  }
  return { manifest, adapter: module.default };
}

/** Every provider this installation carries, in display order. */
export function loadProviders(): Promise<LoadedProvider[]> {
  return Promise.all(providerManifests().map(loadProvider));
}

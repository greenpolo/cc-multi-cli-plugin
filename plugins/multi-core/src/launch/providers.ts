// The providers of this launch: which are enabled, which connect, what each one's native
// runs answer to, and the launcher flags each one owns.

import { readHarnessSettings } from '../gateway/harness-settings.ts';
import {
  type ConnectedProvider,
  type LoadedProvider,
  loadProviders,
} from '../gateway/provider-adapter.ts';
import { providerSelection } from '../install/plugins.ts';
import type { LaunchSettings } from './picker.ts';

/** The connected providers by name, in display order. */
export type ConnectedProviders = Readonly<Record<string, ConnectedProvider>>;

export const enabledProviders = providerSelection(process.env.MULTI_ENABLED_PROVIDERS);
const providerEnabled = (provider: string) => enabledProviders?.includes(provider) ?? true;

/** The caller's settings are known only once the picker is built; native runs read them later. */
export interface CallerSettings {
  args: string[];
  settings?: LaunchSettings;
}

/**
 * Connect every enabled provider at once: the probes are independent, and one model
 * listing alone can take 15 s.
 */
export async function connectProviders(
  loaded: readonly LoadedProvider[],
  caller: CallerSettings,
): Promise<ConnectedProviders> {
  const unknown = enabledProviders?.find(
    (name) => !loaded.some(({ manifest }) => manifest.name === name),
  );
  if (unknown !== undefined) {
    throw new Error(`Unknown Multi provider: ${unknown}`);
  }
  const enabled = loaded.filter(({ manifest }) => providerEnabled(manifest.name));
  const connected = await Promise.all(
    enabled.map(({ manifest, adapter }) =>
      adapter.connect({
        cwd: process.cwd(),
        env: process.env,
        explicit: enabledProviders?.includes(manifest.name) ?? false,
        harnessSettings: (cwd) => readHarnessSettings(cwd, caller.args, caller.settings ?? {}),
      }),
    ),
  );
  const providers: Record<string, ConnectedProvider> = {};
  for (const [index, provider] of connected.entries()) {
    if (provider) {
      providers[enabled[index].manifest.name] = provider;
    }
  }
  return providers;
}

/** Every native harness releases its locks and child processes before the gateway exits. */
export async function closeHarnesses(providers: ConnectedProviders) {
  for (const { harness } of Object.values(providers)) {
    await harness?.close();
  }
}

function help(loaded: readonly LoadedProvider[]): string {
  const commands = loaded.flatMap(({ adapter }) => Object.entries(adapter.commands ?? {}));
  const environment = loaded.flatMap(({ adapter }) => Object.entries(adapter.environment ?? {}));
  return [
    `Usage: node plugins/multi-core/src/launcher.ts [${commands.map(([flag]) => flag).join(' | ')}] [-- <claude arguments>]`,
    'Launch Claude with external models and native coding workers.',
    ...commands.map(([flag, command]) => `${flag}: ${command.help}`),
    ...environment.map(([name, text]) => `${name}: ${text}`),
    'MULTI_MODELS: comma-separated full model IDs to show in /model (unset: defaults; empty: hide external rows)',
  ].join('\n');
}

/** Run a launcher flag a provider owns, or `--help`, and exit; return for anything else. */
export async function handleCommand(command: string | undefined, loaded = loadProviders()) {
  if (command === undefined || !command.startsWith('--')) {
    return;
  }
  const providers = await loaded;
  if (command === '--help') {
    console.log(help(providers));
    process.exit(0);
  }
  for (const { adapter } of providers) {
    const owned = adapter.commands?.[command];
    if (owned) {
      await owned.run();
      process.exit(0);
    }
  }
}

// Connects real provider adapters for a live check that drives the gateway in-process.

import { providerManifest } from '../../plugins/multi-core/src/gateway/provider.ts';
import {
  type ConnectedProvider,
  loadProvider,
} from '../../plugins/multi-core/src/gateway/provider-adapter.ts';

export async function liveProviders(
  names: readonly string[],
): Promise<Record<string, ConnectedProvider>> {
  const providers: Record<string, ConnectedProvider> = {};
  for (const name of names) {
    const manifest = providerManifest(name);
    if (!manifest) {
      throw new Error(`Unknown provider ${name}`);
    }
    const { adapter } = await loadProvider(manifest);
    const connected = await adapter.connect({
      cwd: process.cwd(),
      env: process.env,
      explicit: true,
      harnessSettings: async () => ({}),
    });
    if (!connected) {
      throw new Error(`${manifest.label} is not signed in on this machine`);
    }
    providers[name] = connected;
  }
  return providers;
}

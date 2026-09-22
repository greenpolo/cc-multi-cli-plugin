import type { ProviderUsageReader } from '../../multi-core/src/gateway/provider-usage.ts';
import { formatGrokQuota, readGrokAuth } from './usage.ts';

/** Provider-owned account usage reader injected into the core Mods dashboard. */
export function grokUsageReader(): ProviderUsageReader {
  return async () => formatGrokQuota(await readGrokAuth());
}

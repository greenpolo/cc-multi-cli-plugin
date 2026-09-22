import type { ProviderUsageReader } from '../../multi-core/src/gateway/provider-usage.ts';
import { formatZenQuota, readZenQuota } from './usage.ts';

/** Provider-owned account usage reader injected into the core Mods dashboard. */
export function zenUsageReader(apiKey: string): ProviderUsageReader {
  return async () => formatZenQuota(await readZenQuota({ apiKey }));
}

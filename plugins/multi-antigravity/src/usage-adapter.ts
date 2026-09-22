import type { ProviderUsageReader } from '../../multi-core/src/gateway/provider-usage.ts';
import { formatAntigravityQuota, readAntigravityAccountStatus } from './quota.ts';

/** Provider-owned account usage reader injected into the core Mods dashboard. */
export function antigravityUsageReader(): ProviderUsageReader {
  return async () => formatAntigravityQuota(await readAntigravityAccountStatus());
}

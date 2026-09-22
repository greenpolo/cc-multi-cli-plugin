import type { ProviderUsageReader } from '../../multi-core/src/gateway/provider-usage.ts';
import { formatCursorQuota, readCursorQuota } from './quota.ts';
import { readCursorAccountUsage } from './usage.ts';

interface CursorUsageSource {
  billedUsageForSession: NonNullable<Parameters<typeof readCursorAccountUsage>[2]>;
}

/** Provider-owned account usage reader injected into the core Mods dashboard. */
export function cursorUsageReader(source: CursorUsageSource): ProviderUsageReader {
  return (session) =>
    readCursorAccountUsage(
      session,
      async () => formatCursorQuota(await readCursorQuota()),
      source.billedUsageForSession.bind(source),
    );
}

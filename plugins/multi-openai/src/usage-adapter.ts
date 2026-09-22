import type { ProviderUsageReader } from '../../multi-core/src/gateway/provider-usage.ts';
import { type CodexQuota, readCodexUsage } from './usage.ts';

/** Provider-owned account usage reader injected into the core Mods dashboard. */
export function openAIUsageReader(authFile: string): ProviderUsageReader {
  return async () => codexQuotaView(await readCodexUsage(authFile));
}

function codexQuotaView(quota: CodexQuota) {
  const details = quota.windows.map((window) => {
    const used = Math.max(0, Math.min(100, window.usedPercent));
    const filled = Math.round((used / 100) * 16);
    const bar = '█'.repeat(filled) + '░'.repeat(16 - filled);
    return `${window.label}: ${bar} ${window.usedPercent}% used${window.resetsAt ? ` · resets ${window.resetsAt}` : ''}`;
  });
  if (quota.credits) {
    details.push(
      quota.credits.unlimited
        ? 'Credits: unlimited'
        : `Credits remaining: ${quota.credits.balance ?? 'not reported'}`,
    );
  }
  details.push('Account quota across Codex activity; not API dollar spend.');
  return {
    summary: quota.windows.length
      ? `${quota.plan ? `${quota.plan} · ` : ''}${quota.windows.map((window) => `${window.label}: ${window.usedPercent}% used`).join(' · ')}`
      : 'No account quota windows reported',
    details,
  };
}

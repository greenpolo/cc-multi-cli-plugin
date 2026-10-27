/** Shared by response admission and the Claude Mods worker hooks; keep this module host-free. */
const PROVIDER_WORKERS = new Set([
  'multi-openai',
  'multi-zen',
  'multi-cursor',
  'multi-antigravity',
  'multi-grok',
]);

export function isProviderWorker(type: unknown): boolean {
  return typeof type === 'string' && PROVIDER_WORKERS.has(type);
}

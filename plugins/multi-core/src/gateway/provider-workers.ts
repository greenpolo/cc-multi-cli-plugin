/** Shared by response admission and the Claude Mods worker hooks; keep this module host-free. */
const PROVIDER_WORKER = /^multi-[a-z]+$/;

/** A provider's own Agent type, `multi-<provider>`; `multi-core` is the plugin, not a worker. */
export function isProviderWorker(type: unknown): boolean {
  return typeof type === 'string' && type !== 'multi-core' && PROVIDER_WORKER.test(type);
}

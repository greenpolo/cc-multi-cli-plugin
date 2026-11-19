/**
 * The Agent-tool type of each provider's worker: the CLI's own name, which Claude Code
 * shows wherever it names an agent by its type (the Agent row, a launch of several
 * agents, the agent list), as it shows `Explore` or `Plan`. Shared by response admission
 * and the Claude Mods worker hooks; keep this module host-free.
 */
export const WORKER_TYPES = {
  openai: 'OpenAI',
  zen: 'Zen',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  grok: 'Grok',
} as const;

type Provider = keyof typeof WORKER_TYPES;

const BY_TYPE = new Map<string, Provider>(
  (Object.entries(WORKER_TYPES) as Array<[Provider, string]>).flatMap(([provider, type]) => [
    [type, provider],
    // Before 0.5 the types were `multi-<provider>`; a resumed transcript still names them.
    [`multi-${provider}`, provider],
  ]),
);

/** The provider a worker type belongs to (`Cursor`, or a legacy `multi-cursor`), else undefined. */
function workerProvider(type: unknown): Provider | undefined {
  return typeof type === 'string' ? BY_TYPE.get(type) : undefined;
}

export function isProviderWorker(type: unknown): boolean {
  return workerProvider(type) !== undefined;
}

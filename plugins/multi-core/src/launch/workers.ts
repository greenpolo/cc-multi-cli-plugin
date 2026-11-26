// The Agent types the launched session registers: one worker per connected provider.

import { providerManifest } from '../gateway/provider.ts';
import type { Effort } from '../gateway/responses.ts';
import {
  buildWorkerCatalog,
  type WorkerCatalog,
  workerDescription,
} from '../gateway/worker-catalog.ts';
import type { ConnectedProviders } from './providers.ts';

/**
 * Claude Code requires a non-empty subagent prompt. Workers get no behavioral rules here;
 * provider profiles and Claude's native subagent prompt govern them.
 */
const WORKER_PROMPT = 'Complete the delegated task.';

/**
 * A worker lists no tools, so it inherits the session's whole toolset as a Claude subagent
 * does: MCP servers, web search and fetch, skills and every built-in. Only Claude's
 * permission mode and rules restrict it. The inherited set includes `mcp__multi-core`, which
 * admits the display rows the gateway writes into a harness worker's own transcript.
 */
export interface AgentDefinition {
  description: string;
  prompt: string;
  model: string;
  effort?: Effort;
}

/** The provider workers resolve their models from the session's picker rows. */
export function workerCatalog(
  pickerModels: readonly { model: string }[],
  providers: ConnectedProviders,
): WorkerCatalog {
  return buildWorkerCatalog(
    pickerModels,
    Object.fromEntries(Object.entries(providers).map(([name, { worker }]) => [name, worker])),
  );
}

/**
 * One Agent type per signed-in provider. The definition's model is the provider's
 * default; an Agent call's `model` selects another, resolved by the mod at spawn.
 */
export function workerDefinitions(catalog: WorkerCatalog): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};
  for (const worker of Object.values(catalog)) {
    const manifest = providerManifest(worker.provider);
    const model = worker.models.find((entry) => entry.id === worker.defaultId)?.model;
    if (!model || !manifest) {
      continue;
    }
    agents[worker.type] = {
      description: workerDescription(worker, manifest.runs),
      prompt: WORKER_PROMPT,
      model,
      ...(worker.effort ? { effort: worker.effort as Effort } : {}),
    };
  }
  return agents;
}

interface LauncherInvocation {
  command: string;
  args: readonly string[];
  viaComSpec?: boolean;
}

export function checkLauncherArgumentLimit(
  agents: Record<string, AgentDefinition>,
  invocation: LauncherInvocation,
  executable: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    return;
  }
  const viaComSpec = invocation.viaComSpec ?? /(?:^|[\\/])cmd\.exe$/i.test(invocation.command);
  const limit = viaComSpec ? 8000 : 32000;
  const commandLine = [invocation.command, ...invocation.args].join(' ');
  if (commandLine.length <= limit) {
    return;
  }
  const providers = new Map<string, number>();
  for (const [name, agent] of Object.entries(agents)) {
    const provider = agent.model.split('/')[1] ?? 'unknown';
    providers.set(
      provider,
      (providers.get(provider) ?? 0) + Buffer.byteLength(JSON.stringify({ [name]: agent })),
    );
  }
  const largest = [...providers.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([provider, bytes]) => `${provider} (${bytes} B)`)
    .join(', ');
  const shim = viaComSpec ? ' cmd.exe shim' : '';
  throw new Error(
    `Native worker registration needs ${commandLine.length.toLocaleString('en-US')} characters for ${executable}, above the Windows${shim} limit of ${limit.toLocaleString('en-US')}. Largest providers: ${largest || 'none'}. Disable providers or extra models to reduce the launcher arguments.`,
  );
}

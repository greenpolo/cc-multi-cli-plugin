// What a Claude desktop app session takes from Multi. The desktop app starts Claude Code
// itself, so no launcher runs: the mod starts the gateway (serve.ts) and reads one line
// from it, the handshake, then sets the session's environment and registers the workers.

import { loadProviders } from '../gateway/provider-adapter.ts';
import { readInstallation, updatePickerRows } from '../install/installation.ts';
import type { OpenGateway } from './gateway.ts';
import { filterPicker, pickerSettings } from './picker.ts';
import { connectProviders } from './providers.ts';

/**
 * The variables a desktop session takes from the gateway. The mod sets each by name and
 * no other, so this list and the mod's (hooks/register.ts) are the same.
 * `NODE_EXTRA_CA_CERTS` is not among them: Claude Code reads it once, at its own start.
 */
const DESKTOP_VARIABLES = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ENABLE_TOOL_SEARCH',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'CLAUDE_ENV_FILE',
  'MULTI_GATEWAY_TOKEN',
  'MULTI_MOD_GATEWAY_URL',
  'MULTI_ORIG_ANTHROPIC_BASE_URL',
  'MULTI_ORIG_ANTHROPIC_CUSTOM_HEADERS',
  'MULTI_ORIG_HTTPS_PROXY',
  'MULTI_ORIG_https_proxy',
  'MULTI_ORIG_NO_PROXY',
  'MULTI_ORIG_no_proxy',
  'MULTI_ORIG_NODE_EXTRA_CA_CERTS',
  'MULTI_ORIG_CLAUDE_ENV_FILE',
] as const;

/** One worker type for the mod's `$.agent.register`. */
interface DesktopWorker {
  name: string;
  description: string;
  prompt: string;
  model: string;
  effort?: string;
}

/** The one line serve.ts writes once its gateway listens. */
export interface Handshake {
  /** The session's variables, by name; an empty string unsets one. */
  env: Record<string, string>;
  workers: DesktopWorker[];
  /** Whether Claude reaches the gateway as its HTTPS proxy, which keeps Remote Control. */
  frontDoor: boolean;
  /** One line for the person, when something they can fix is off. */
  notice?: string;
}

/** What differs from the session's own environment, among the variables the mod sets. */
export function handshake(gateway: OpenGateway, notice: string | undefined): Handshake {
  const env: Record<string, string> = {};
  for (const name of DESKTOP_VARIABLES) {
    const value = gateway.environment[name];
    if (value !== process.env[name]) {
      env[name] = value ?? '';
    }
  }
  return {
    env,
    workers: Object.entries(gateway.agents).map(([name, agent]) => ({
      name,
      description: agent.description,
      prompt: agent.prompt,
      model: agent.model,
      ...(agent.effort ? { effort: agent.effort } : {}),
    })),
    frontDoor: gateway.frontDoor !== undefined,
    ...(notice ? { notice } : {}),
  };
}

/** The saved `/model` selection: the launcher's `MULTI_MODELS`, or what setup recorded. */
export async function savedModels(): Promise<string | undefined> {
  if (process.env.MULTI_MODELS !== undefined) {
    return process.env.MULTI_MODELS;
  }
  try {
    return (await readInstallation()).models;
  } catch {
    return undefined;
  }
}

/** Write the connected providers' `/model` rows to Claude's user settings (setup.ts). */
export async function refreshPickerRows(): Promise<void> {
  const loaded = loadProviders();
  const providers = await connectProviders(await loaded, { args: [] });
  const selection = await savedModels();
  const fullCatalog = selection !== undefined;
  const defaults = fullCatalog
    ? pickerSettings(providers).modelPicker.options.map((option) => option.model)
    : [];
  const settings = pickerSettings(providers, fullCatalog);
  filterPicker(settings, selection, defaults);
  await updatePickerRows(settings.modelPicker.options);
}

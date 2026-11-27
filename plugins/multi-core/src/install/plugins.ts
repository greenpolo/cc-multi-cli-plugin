import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { executableInvocation } from '../gateway/executable.ts';

const MARKETPLACE = 'cc-multi-cli-plugin';
interface Plugin {
  id: string;
  enabled: boolean;
  scope: string;
  installPath: string;
  errors?: unknown;
}

/**
 * The provider names a session was launched with. This file is also copied on its own into
 * Multi's data directory, so it knows the shape of a provider name and not the provider list:
 * the launcher refuses a name no provider folder answers to.
 */
export function providerSelection(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return [...new Set(value.split(',').filter(Boolean))].map((id) => {
    if (!/^[a-z]+$/.test(id)) {
      throw new Error(`Unknown Multi provider: ${id}`);
    }
    return id;
  });
}

/** Ask Claude for its enabled plugins rather than interpreting its cache layout. */
export async function installedPlugins(
  claude: string,
  settingsArgs: string[] = [],
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const invocation = executableInvocation(
    claude,
    [...settingsArgs, 'plugin', 'list', '--json'],
    platform,
    env,
  );
  const { stdout } = await promisify(execFile)(invocation.command, invocation.args, {
    env,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
    ...invocation.options,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('Claude returned an invalid plugin list. Update Claude Code and retry.');
  }
  const plugins = parsed.filter((item): item is Plugin => {
    return (
      item !== null &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.enabled === 'boolean' &&
      typeof item.scope === 'string' &&
      typeof item.installPath === 'string' &&
      path.isAbsolute(item.installPath)
    );
  });
  for (const plugin of plugins) {
    if (
      plugin.enabled &&
      plugin.id.endsWith(`@${MARKETPLACE}`) &&
      Array.isArray(plugin.errors) &&
      plugin.errors.length
    ) {
      throw new Error(
        `Claude reports errors for ${plugin.id}. Repair the plugin installation before launching Multi.`,
      );
    }
  }
  const core = plugins.filter(
    (plugin) => plugin.id === `multi-core@${MARKETPLACE}` && plugin.enabled,
  );
  // Startup executes before the workspace trust prompt. Only a user-installed
  // core may supply executable code here; project providers are fixed opt-ins.
  const personalCore = core.filter((plugin) => plugin.scope === 'user');
  if (core.length && personalCore.length !== 1) {
    throw new Error('Install multi-core at user scope before running Multi setup.');
  }
  const providers = [
    ...new Set(
      plugins.flatMap((plugin) => {
        const name = new RegExp(`^multi-([a-z]+)@${MARKETPLACE}$`).exec(plugin.id)?.[1];
        return plugin.enabled && name !== undefined && name !== 'core' ? [name] : [];
      }),
    ),
  ];
  return { root: personalCore[0]?.installPath, providers };
}

export function settingsArguments(args: string[]): string[] {
  const selected: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      break;
    }
    if (['--settings', '--setting-sources'].includes(arg)) {
      const value = args[++index];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      selected.push(arg, value);
    } else if (arg.startsWith('--settings=') || arg.startsWith('--setting-sources=')) {
      selected.push(arg);
    }
  }
  return selected;
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Installation, readInstallation, uninstall } from './installation.ts';
import { installedPlugins, settingsArguments } from './plugins.ts';
import { needsEnvProxy, run, withoutGateway } from './process.ts';

async function dispatch(state: Installation, args: string[], management: boolean) {
  const { root, providers } = await installedPlugins(state.claude, settingsArguments(args));
  if (management && args[0] === 'status') {
    console.log(JSON.stringify({ core: root ?? null, providers, claude: state.claude }, null, 2));
    return 0;
  }
  if (!management && (!root || providers.length === 0)) {
    return run(state.claude, args, { env: withoutGateway(process.env) });
  }
  if (!management && state.command === 'claude' && process.env.MULTI_GATEWAY_TOKEN) {
    // A launch command named `claude` also catches Claude's own nested runs (agents
    // calling `claude -p`, SDK spawns, hooks). Inside a Multi session those must
    // reach the real executable rather than start a second gateway, and without this
    // session's gateway URL and credentials: that gateway is not theirs.
    return run(state.claude, args, { env: withoutGateway(process.env) });
  }
  if (!root) {
    throw new Error('Enable multi-core at user scope before using Multi commands.');
  }
  const manifest = JSON.parse(
    await readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  if (manifest.name !== 'multi-core') {
    throw new Error('Installed core manifest does not identify multi-core');
  }
  const env = {
    ...process.env,
    ...(state.models !== undefined && process.env.MULTI_MODELS === undefined
      ? { MULTI_MODELS: state.models }
      : {}),
    // Node reads this at startup only, so the launcher process has to be started with it.
    ...(needsEnvProxy(process.env) ? { NODE_USE_ENV_PROXY: '1' } : {}),
    MULTI_REAL_CLAUDE: state.claude,
    MULTI_ENABLED_PROVIDERS: providers.join(','),
    MULTI_ANTIGRAVITY: providers.includes('antigravity') ? '1' : '0',
  };
  const entry = management ? 'account.ts' : 'launcher.ts';
  return run(state.node, [path.join(root, 'plugins', 'multi-core', 'src', entry), ...args], {
    env,
  });
}

async function main() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const state = await readInstallation(directory);
  const args = process.argv.slice(2);
  if (args[0] === '--multi') {
    if (args[1] !== 'uninstall') {
      return dispatch(state, args.slice(1), true);
    }
    await uninstall(directory);
    console.log('Multi startup removed. Open a new terminal. Provider logins are preserved.');
    return 0;
  }
  return dispatch(state, args, false);
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`Multi: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);

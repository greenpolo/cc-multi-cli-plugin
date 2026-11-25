#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableInvocation, resolveExecutable } from './gateway/executable.ts';
import { loadProviders } from './gateway/provider-adapter.ts';
import { installedCertificate } from './launch/certificate.ts';
import {
  anthropicSignedIn,
  assertFunctionHooksSupported,
  claudeExecutable,
  findPluginRoot,
  launcherArguments,
  pluginInventoryOrEmpty,
  validateSessionLaunch,
} from './launch/claude.ts';
import { warnIfProxyUnused, withNestedClaudeShim } from './launch/environment.ts';
import { frontDoorFor, openGateway } from './launch/gateway.ts';
import { applyModelArgument, initialSelection } from './launch/picker.ts';
import { type CallerSettings, connectProviders, handleCommand } from './launch/providers.ts';
import { checkLauncherArgumentLimit } from './launch/workers.ts';

async function main() {
  const args = process.argv.slice(2);
  const loaded = loadProviders();
  await handleCommand(args[0], loaded);
  if (args[0] === '--') {
    args.shift();
  }
  validateSessionLaunch(args);
  warnIfProxyUnused();
  const pluginRoot = await findPluginRoot(fileURLToPath(import.meta.url));
  await assertFunctionHooksSupported();
  const caller: CallerSettings = { args };
  const [pluginInventory, anthropic, providers, installed] = await Promise.all([
    pluginInventoryOrEmpty(process.cwd(), args),
    anthropicSignedIn(),
    loaded.then((all) => connectProviders(all, caller)),
    installedCertificate(),
  ]);
  const gateway = await openGateway({
    args,
    caller,
    loaded,
    providers,
    pluginInventory,
    anthropic,
    cwd: process.cwd(),
    frontDoor: frontDoorFor(anthropic, installed),
  });
  const { settings, agents, settingsDir } = gateway;
  // Agent view and background sessions are off for this session only, through the
  // session's own settings: nested Claude runs do not read them, unlike an environment
  // variable. The background supervisor does not carry --agents or this session's gateway
  // environment, and outlives the child whose exit releases settingsDir and the gateway,
  // so a session handed to it would lose its workers and its gateway. Ordinary background
  // subagent tasks stay available inside this session.
  settings.disableAgentView = true;
  const settingsFile = path.join(settingsDir, 'settings.json');
  const { modelArgument } = await initialSelection(args, settings, anthropic, providers);
  if (modelArgument) {
    applyModelArgument(args, modelArgument);
  }
  await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  const definitions = JSON.stringify(agents);
  const claudePath = resolveExecutable('claude', {
    configuredPath: claudeExecutable,
    env: gateway.environment,
  });
  const childEnvironment = await withNestedClaudeShim(gateway.environment, settingsDir, claudePath);
  const childArguments = launcherArguments(
    args,
    settingsFile,
    definitions,
    pluginInventory,
    pluginRoot,
  );
  const childInvocation = executableInvocation(
    claudePath,
    childArguments,
    process.platform,
    childEnvironment,
  );
  try {
    checkLauncherArgumentLimit(agents, childInvocation, claudePath, process.platform);
  } catch (error) {
    await gateway.close();
    throw error;
  }
  const child = spawn(childInvocation.command, childInvocation.args, {
    stdio: 'inherit',
    env: childEnvironment,
    detached: process.platform !== 'win32',
    ...childInvocation.options,
  });
  // Claude's own exit ends the launcher with Claude's exit code. Nothing here waits on the
  // mod: a first-run consent screen can hold its start for as long as the user reads it.
  child.once('exit', (code) => {
    void gateway.close().finally(() => process.exit(code ?? 1));
  });
  child.once('error', (error) => {
    console.error(error.message);
    void gateway.close().finally(() => process.exit(1));
  });
  if (process.platform === 'win32') {
    // Windows console control events do not provide POSIX process groups. Claude's
    // child owns Ctrl+C handling; forward termination explicitly to its process tree.
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => {});
  } else {
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    // Unix foreground terminals deliver SIGINT to both processes; Claude owns its
    // interrupt UI, so the gateway deliberately remains alive.
    process.on('SIGINT', () => {});
  }
}

/**
 * Claude's plugin cache may be a symlink to a checkout. Node resolves the entry
 * module to its real path, so compare real paths rather than the argv spelling.
 */
function isEntryModule(argument: string | undefined): boolean {
  if (!argument) {
    return false;
  }
  const entry = fileURLToPath(import.meta.url);
  const resolved = path.resolve(argument);
  if (resolved === entry) {
    return true;
  }
  try {
    return realpathSync(resolved) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isEntryModule(process.argv[1])) {
  void main().catch((error) => {
    console.error(`Native gateway: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

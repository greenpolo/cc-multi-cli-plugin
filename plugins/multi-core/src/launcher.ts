#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkerPermissions } from './gateway/agent-definitions.ts';
import { executableInvocation, resolveExecutable } from './gateway/executable.ts';
import { ModBridge } from './gateway/mod-bridge.ts';
import { PermissionModes } from './gateway/mode-hook.ts';
import { loadProviders } from './gateway/provider-adapter.ts';
import { ReceiptLedger } from './gateway/receipts.ts';
import type { GatewayEvent } from './gateway/server.ts';
import { createNativeGateway } from './gateway/server.ts';
import { withoutGateway } from './install/process.ts';
import {
  anthropicSignedIn,
  assertFunctionHooksSupported,
  awaitModSessionStart,
  awaitStartOrExit,
  claudeExecutable,
  findPluginRoot,
  launcherArguments,
  pluginInventoryOrEmpty,
  validateSessionLaunch,
} from './launch/claude.ts';
import {
  gatewayEnvironment,
  warnIfProxyUnused,
  withNestedClaudeShim,
} from './launch/environment.ts';
import {
  applyModelArgument,
  filterPicker,
  initialSelection,
  mergeSettings,
  pickerSettings,
} from './launch/picker.ts';
import {
  type CallerSettings,
  closeHarnesses,
  connectProviders,
  enabledProviders,
  handleCommand,
  nativeSettingsCheck,
} from './launch/providers.ts';
import { checkLauncherArgumentLimit, workerCatalog, workerDefinitions } from './launch/workers.ts';

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
  const fullCatalog = process.env.MULTI_MODELS !== undefined;
  const caller: CallerSettings = { args };
  const [pluginInventory, anthropic, providers] = await Promise.all([
    pluginInventoryOrEmpty(process.cwd(), args),
    anthropicSignedIn(),
    loaded.then((all) => connectProviders(all, caller)),
  ]);
  const token = randomBytes(32).toString('hex');
  const defaultModels = fullCatalog
    ? pickerSettings(providers).modelPicker.options.map((option) => option.model)
    : [];
  const settings = pickerSettings(providers, fullCatalog);
  await mergeSettings(args, settings);
  // Agent view and background sessions are off for this session only, through the
  // session's own settings: nested Claude runs do not read them, unlike an environment
  // variable. The background supervisor does not carry --agents or this session's gateway
  // environment, and outlives the child whose exit releases settingsDir and the gateway,
  // so a session handed to it would lose its workers and its gateway. Ordinary background
  // subagent tasks stay available inside this session.
  settings.disableAgentView = true;
  filterPicker(settings, process.env.MULTI_MODELS, defaultModels);
  const callerSettings = structuredClone(settings);
  caller.settings = callerSettings;
  const workers = workerCatalog(settings.modelPicker.options, providers);
  const agents = workerDefinitions(workers);
  const modBridge = new ModBridge();
  const settingsDir = await mkdtemp(path.join(os.tmpdir(), 'multi-native-settings-'));
  const callerSettingsFile = path.join(settingsDir, 'caller-settings.json');
  await writeFile(callerSettingsFile, JSON.stringify(callerSettings), { mode: 0o600 });
  const permissionModes = new PermissionModes(
    (cwd) =>
      loadWorkerPermissions(
        cwd,
        agents,
        [...args, '--settings', callerSettingsFile],
        pluginInventory,
      ),
    nativeSettingsCheck(providers, caller),
    { workers },
  );
  await permissionModes.precompute(process.cwd());
  const receipts = new ReceiptLedger({
    file: process.env.MULTI_RECEIPTS_FILE
      ? path.resolve(process.env.MULTI_RECEIPTS_FILE)
      : undefined,
    onError: (error) => {
      process.stderr.write(`[native] receipt not written: ${String(error)}\n`);
    },
  });
  const server = createNativeGateway({
    receipts,
    token,
    enabledProviders,
    modBridge,
    providers,
    signaturePrefixes: (await loaded).flatMap(({ adapter }) => adapter.signaturePrefixes ?? []),
    permissionModes,
    // A launch inside another Multi session forwards to the user's own upstream, not the outer gateway.
    anthropicBaseUrl: withoutGateway(process.env).ANTHROPIC_BASE_URL || undefined,
    blockAnthropic: !anthropic,
    onEvent: traceEvent,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Gateway did not bind a local port.');
  }
  const settingsFile = path.join(settingsDir, 'settings.json');
  const { modelArgument } = await initialSelection(args, settings, anthropic, providers);
  if (modelArgument) {
    applyModelArgument(args, modelArgument);
  }
  await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  const definitions = JSON.stringify(agents);
  const baseEnvironment = gatewayEnvironment(address.port, token, anthropic);
  const claudePath = resolveExecutable('claude', {
    configuredPath: claudeExecutable,
    env: baseEnvironment,
  });
  const childEnvironment = await withNestedClaudeShim(baseEnvironment, settingsDir, claudePath);
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
    server.close();
    await closeHarnesses(providers);
    receipts.finishAll();
    await receipts.drain();
    await rm(settingsDir, { recursive: true, force: true });
    throw error;
  }
  const modStart = awaitModSessionStart();
  const child = spawn(childInvocation.command, childInvocation.args, {
    stdio: 'inherit',
    env: childEnvironment,
    detached: process.platform !== 'win32',
    ...childInvocation.options,
  });
  const shutdown = async () => {
    server.closeAllConnections();
    server.close();
    await closeHarnesses(providers);
    receipts.finishAll();
    await receipts.drain();
    await rm(settingsDir, { recursive: true, force: true });
  };
  // Attached before anything is awaited: a Claude that cannot start, or that exits at
  // once (--version, an argument error), must end the launcher with its own exit code
  // rather than after the mod's acknowledgement times out.
  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code) => resolve(code ?? 1));
  });
  child.once('error', (error) => {
    modStart.cancel();
    console.error(error.message);
    void shutdown().finally(() => process.exit(1));
  });
  await awaitStartOrExit(modStart, exited, child, shutdown);
  void exited.then((code) => shutdown().finally(() => process.exit(code)));
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

function traceEvent(event: GatewayEvent) {
  if (process.env.MULTI_NATIVE_TRACE === '1') {
    process.stderr.write(`[native] ${JSON.stringify(event)}\n`);
  }
}

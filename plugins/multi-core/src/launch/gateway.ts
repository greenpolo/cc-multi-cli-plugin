// The gateway a session runs against, started the same way for the terminal launcher
// (launcher.ts, which then starts Claude Code) and for a desktop session (serve.ts, which
// hands the running gateway to the mod that started it).

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  loadWorkerPermissions,
  type PluginPermissionInventory,
} from '../gateway/agent-definitions.ts';
import { ModBridge } from '../gateway/mod-bridge.ts';
import { PermissionModes } from '../gateway/mode-hook.ts';
import type { LoadedProvider } from '../gateway/provider-adapter.ts';
import { ReceiptLedger } from '../gateway/receipts.ts';
import type { ServerCertificate } from '../gateway/self-signed.ts';
import type { GatewayEvent } from '../gateway/server.ts';
import { createNativeGateway } from '../gateway/server.ts';
import { withoutGateway } from '../install/process.ts';
import { gatewayEnvironment } from './environment.ts';
import { type FrontDoorFiles, prepareFrontDoor } from './front-door.ts';
import { filterPicker, type LaunchSettings, mergeSettings, pickerSettings } from './picker.ts';
import {
  type CallerSettings,
  type ConnectedProviders,
  closeHarnesses,
  enabledProviders,
} from './providers.ts';
import { type AgentDefinition, workerCatalog, workerDefinitions } from './workers.ts';

export interface GatewayOptions {
  /** Claude's arguments; `--settings` among them is folded into the picker settings. */
  args: string[];
  caller: CallerSettings;
  loaded: Promise<readonly LoadedProvider[]>;
  providers: ConnectedProviders;
  pluginInventory: PluginPermissionInventory;
  /** Whether Claude itself is signed in to Anthropic. */
  anthropic: boolean;
  /** The workspace whose worker permissions are read first. */
  cwd: string;
  /** How the front door is set up (launch/front-door.ts); left out, it never opens. */
  frontDoor?: (server: Server, settingsDir: string) => Promise<FrontDoorFiles | undefined>;
  /** A gateway its mod started ends when the mod asks (`/multi/mod/stop`). */
  onStop?: () => void;
}

export interface OpenGateway {
  port: number;
  token: string;
  /** The session's picker settings: the `/model` rows of the connected providers. */
  settings: LaunchSettings;
  /** The provider worker types, by type. */
  agents: Record<string, AgentDefinition>;
  /** A private folder that lives as long as the gateway. */
  settingsDir: string;
  frontDoor: FrontDoorFiles | undefined;
  /** What the session's Claude Code runs with to reach this gateway. */
  environment: NodeJS.ProcessEnv;
  /** Ends every connection, run and file of this gateway. */
  close: () => Promise<void>;
}

export async function openGateway(options: GatewayOptions): Promise<OpenGateway> {
  const { args, caller, providers } = options;
  const fullCatalog = process.env.MULTI_MODELS !== undefined;
  const token = randomBytes(32).toString('hex');
  const defaultModels = fullCatalog
    ? pickerSettings(providers).modelPicker.options.map((option) => option.model)
    : [];
  const settings = pickerSettings(providers, fullCatalog);
  await mergeSettings(args, settings);
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
        options.pluginInventory,
      ),
    { workers },
  );
  await permissionModes.ready(options.cwd);
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
    signaturePrefixes: (await options.loaded).flatMap(
      ({ adapter }) => adapter.signaturePrefixes ?? [],
    ),
    permissionModes,
    // A launch inside another Multi session forwards to the user's own upstream, not the outer gateway.
    anthropicBaseUrl: withoutGateway(process.env).ANTHROPIC_BASE_URL || undefined,
    blockAnthropic: !options.anthropic,
    onEvent: traceEvent,
    onStop: options.onStop,
  });
  const close = async () => {
    server.closeAllConnections();
    server.close();
    await closeHarnesses(providers);
    receipts.finishAll();
    await receipts.drain();
    await rm(settingsDir, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Gateway did not bind a local port.');
    }
    const frontDoor = await options.frontDoor?.(server, settingsDir);
    return {
      port: address.port,
      token,
      settings,
      agents,
      settingsDir,
      frontDoor,
      environment: gatewayEnvironment(address.port, token, options.anthropic, frontDoor),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The front door with a certificate of the launch's own, or the installed one. */
export function frontDoorFor(anthropic: boolean, certificate?: ServerCertificate) {
  return (server: Server, settingsDir: string) =>
    prepareFrontDoor(server, settingsDir, withoutGateway(process.env), anthropic, certificate);
}

function traceEvent(event: GatewayEvent) {
  if (process.env.MULTI_NATIVE_TRACE === '1') {
    process.stderr.write(`[native] ${JSON.stringify(event)}\n`);
  }
}

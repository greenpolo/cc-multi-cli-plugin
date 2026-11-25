#!/usr/bin/env node
// The gateway for a Claude desktop app session, started by the mod (hooks/register.ts) in
// the session's own folder and environment. It writes one handshake line on stdout
// (launch/desktop.ts) and ends when the mod asks (`/multi/mod/stop`), when the Claude Code
// that started it is gone, or when it is killed.

import { loadProviders } from './gateway/provider-adapter.ts';
import { updatePickerRows } from './install/installation.ts';
import { installedCertificate, trusts } from './launch/certificate.ts';
import { pluginInventoryOrEmpty } from './launch/claude.ts';
import { handshake, savedModels } from './launch/desktop.ts';
import { frontDoorFor, type OpenGateway, openGateway } from './launch/gateway.ts';
import { type CallerSettings, connectProviders } from './launch/providers.ts';

const PARENT_CHECK_MS = 2000;

/** Remote Control needs the front door, which needs Claude to trust its certificate. */
const UNTRUSTED =
  "Multi: Remote Control is off in this session because Claude does not trust Multi's gateway yet; run /multi-core:setup, then start a new session.";

async function main() {
  const cwd = process.cwd();
  const selection = await savedModels();
  if (selection !== undefined) {
    process.env.MULTI_MODELS = selection;
  }
  const args: string[] = [];
  const caller: CallerSettings = { args };
  const loaded = loadProviders();
  const [pluginInventory, providers, installed] = await Promise.all([
    pluginInventoryOrEmpty(cwd, args),
    loaded.then((all) => connectProviders(all, caller)),
    installedCertificate(),
  ]);
  // The desktop app runs only signed in to Claude, so Anthropic passthrough stays open.
  const trusted = installed && (await trusts(process.env.NODE_EXTRA_CA_CERTS, installed));
  let gateway: OpenGateway | undefined;
  const stop = () => {
    void (gateway?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  gateway = await openGateway({
    args,
    caller,
    loaded,
    providers,
    pluginInventory,
    anthropic: true,
    cwd,
    frontDoor: trusted ? frontDoorFor(true, installed) : undefined,
    onStop: stop,
  });
  try {
    await updatePickerRows(gateway.settings.modelPicker.options);
  } catch (error) {
    process.stderr.write(`Multi: /model rows not updated: ${String(error)}\n`);
  }
  process.stdout.write(`${JSON.stringify(handshake(gateway, trusted ? undefined : UNTRUSTED))}\n`);
  watchParent(process.ppid, stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/** No gateway outlives the Claude Code that started it, however that one ended. */
function watchParent(parent: number, stop: () => void) {
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      stop();
    }
  }, PARENT_CHECK_MS).unref();
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Multi gateway: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

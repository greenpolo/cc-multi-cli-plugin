import { fileURLToPath } from 'node:url';
import { providerManifest, providerManifests } from './gateway/provider.ts';
import { loadProvider } from './gateway/provider-adapter.ts';
import { providerSelection } from './install/plugins.ts';
import { run } from './install/process.ts';

async function usage(): Promise<string> {
  const verbs: string[] = [];
  for (const manifest of providerManifests()) {
    const { adapter } = await loadProvider(manifest);
    if (adapter.account) {
      verbs.push(`${adapter.account.verb} ${manifest.name}`);
    }
  }
  return `Usage: multi status | ${verbs.join(' | ')} | uninstall`;
}

async function main() {
  const [command, provider, ...args] = process.argv.slice(2);
  const enabled = providerSelection(process.env.MULTI_ENABLED_PROVIDERS) ?? [];
  const manifest = providerManifest(provider);
  if (!manifest || !enabled.includes(manifest.name)) {
    throw new Error('Install and enable the requested Multi provider plugin first.');
  }
  const { account } = (await loadProvider(manifest)).adapter;
  if (command !== 'login' && command !== 'connect') {
    throw new Error(await usage());
  }
  if (!account || account.verb !== command) {
    throw new Error(
      account
        ? `${manifest.label} uses multi ${account.verb} ${manifest.name}, not multi ${command}.`
        : await usage(),
    );
  }
  return account.run(args, {
    run,
    launcher: (flag) =>
      run(process.execPath, [fileURLToPath(new URL('./launcher.ts', import.meta.url)), flag]),
  });
}

// Browser links are emitted by the provider-owned login process. Never read tokens.
void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);

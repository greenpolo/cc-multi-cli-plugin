import { fileURLToPath } from 'node:url';
import { readZenKey, saveZenKey } from '../../multi-zen/src/auth.ts';
import { providerSelection } from './install/plugins.ts';
import { run } from './install/process.ts';

async function secretInput(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Run multi connect zen in your own terminal for hidden key entry. Do not paste the key into Claude.',
    );
  }
  process.stderr.write('Zen API key (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = '';
  return new Promise<string>((resolve, reject) => {
    const finish = (error?: Error) => {
      process.stdin.off('data', data);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const data = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        switch (character) {
          case '\u0003':
            finish(new Error('Key entry cancelled'));
            return;
          case '\r':
          case '\n':
            finish();
            return;
          case '\u007f':
          case '\b':
            value = value.slice(0, -1);
            break;
          default:
            if (/^[ -~]$/.test(character)) {
              value += character;
            }
        }
      }
    };
    process.stdin.on('data', data);
  });
}

async function connectZen() {
  if (await readZenKey()) {
    console.log('Zen credentials found. Relaunch Claude to load Zen models.');
    return 0;
  }
  console.log('Create a Zen API key at https://opencode.ai/auth');
  await saveZenKey(await secretInput());
  console.log('Zen key saved to OpenCode auth. Relaunch Claude to load Zen models.');
  return 0;
}

async function main() {
  const [command, provider, ...args] = process.argv.slice(2);
  const enabled = providerSelection(process.env.MULTI_ENABLED_PROVIDERS) ?? [];
  if (!enabled.some((name) => name === provider)) {
    throw new Error('Install and enable the requested Multi provider plugin first.');
  }
  if (command === 'connect' && provider === 'zen' && args.length === 0) {
    return connectZen();
  }
  if (command !== 'login') {
    throw new Error(
      'Usage: multi status | login openai [--device-auth] | login cursor | connect zen | login antigravity | login grok | uninstall',
    );
  }
  if (provider === 'openai' && args.every((arg) => arg === '--device-auth')) {
    return run('codex', ['-c', 'cli_auth_credentials_store=file', 'login', ...args]);
  }
  if (args.length) {
    throw new Error('Unsupported login arguments');
  }
  if (provider === 'cursor') {
    return run(process.execPath, [
      fileURLToPath(new URL('./launcher.ts', import.meta.url)),
      '--cursor-login',
    ]);
  }
  if (provider === 'grok') {
    // Grok Build owns its own browser and device-code flows; never proxy them.
    return run('grok', ['login']);
  }
  if (provider === 'antigravity') {
    return run(process.execPath, [
      fileURLToPath(new URL('./launcher.ts', import.meta.url)),
      '--antigravity-setup',
    ]);
  }
  throw new Error('Zen uses multi connect zen, not OAuth login.');
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

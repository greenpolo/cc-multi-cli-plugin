import type { ProviderAdapter } from '../../multi-core/src/gateway/provider-adapter.ts';
import { readZenKey, saveZenKey, validateZenKey } from './auth.ts';
import { prepareZenRequest, zenSignaturePrefixes } from './gateway-request.ts';
import {
  ZEN_DEFAULT_WORKER_MODEL,
  ZEN_MODELS,
  ZEN_WORKER_EFFORT,
  zenModelOptions,
  zenPickerOptions,
} from './models.ts';
import { zenUsageReader } from './usage-adapter.ts';

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

async function connectZen(replace: boolean): Promise<number> {
  if (!replace && (await readZenKey())) {
    console.log(
      'Zen credentials found. Relaunch Claude to load Zen models, or run `multi connect zen --replace` to save a new key.',
    );
    return 0;
  }
  console.log('Create a Zen API key at https://opencode.ai/auth');
  await saveZenKey(await secretInput());
  console.log('Zen key saved to OpenCode auth. Relaunch Claude to load Zen models.');
  return 0;
}

const adapter: ProviderAdapter = {
  signaturePrefixes: zenSignaturePrefixes,
  async connect({ env }) {
    const apiKey = await readZenKey();
    if (!apiKey) {
      return undefined;
    }
    validateZenKey(apiKey);
    return {
      rows: (fullCatalog) =>
        (fullCatalog ? zenModelOptions() : zenPickerOptions(env.MULTI_ZEN_MODELS)).map(
          ({ model, label, efforts }) => ({
            model,
            label: `Zen · ${label}`,
            description: `Zen API billing · Claude tools${efforts ? '' : ' · native reasoning; /effort not applicable'}`,
            adjustableEffort: Boolean(efforts?.length),
          }),
        ),
      worker: { defaultId: () => ZEN_DEFAULT_WORKER_MODEL, effort: ZEN_WORKER_EFFORT },
      prepare: (input) => prepareZenRequest(input, apiKey),
      usage: zenUsageReader(apiKey),
    };
  },
  commands: {
    '--zen-models': {
      help: 'list supported Zen models and capabilities',
      async run() {
        console.log(JSON.stringify(ZEN_MODELS, null, 2));
      },
    },
  },
  environment: {
    OPENCODE_API_KEY: 'Zen key (or use OpenCode /connect)',
    MULTI_ZEN_MODELS: 'comma-separated Zen model IDs to show, leaving other providers unchanged',
  },
  account: {
    verb: 'connect',
    run(args) {
      if (!args.every((arg) => arg === '--replace')) {
        throw new Error('Unsupported connect arguments');
      }
      return connectZen(args.length > 0);
    },
  },
};

export default adapter;

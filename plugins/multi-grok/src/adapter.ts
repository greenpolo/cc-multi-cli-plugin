import { resolveExecutable } from '../../multi-core/src/gateway/executable.ts';
import { mergePermissions } from '../../multi-core/src/gateway/harness-settings.ts';
import type { ProviderAdapter } from '../../multi-core/src/gateway/provider-adapter.ts';
import { GrokHarness } from './harness.ts';
import {
  discoverGrokModels,
  type GrokModel,
  grokDefaultWorkerModel,
  grokPickerOptions,
} from './models.ts';
import { GROK_TOOLS, grokPermissionPolicy } from './permissions.ts';
import { grokUsageReader } from './usage-adapter.ts';

const adapter: ProviderAdapter = {
  async connect({ env, explicit, harnessSettings }) {
    let models: GrokModel[] = [];
    try {
      resolveExecutable('grok');
      models = await discoverGrokModels();
    } catch (error) {
      // Silent when the plugin is merely present: only an enabled provider reports.
      if (explicit) {
        console.error(
          `Grok choices unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!models.length) {
      return undefined;
    }
    const harness = new GrokHarness(models, {
      checkPermissions: async (cwd, context) =>
        grokPermissionPolicy(
          mergePermissions(context, await harnessSettings(cwd, grokPermissionPolicy)),
        ),
    });
    return {
      rows: () =>
        grokPickerOptions(models, env.MULTI_GROK_MODELS).map(({ model, label }) => ({
          model,
          label: `Grok - ${label}`,
          description: 'Grok subscription; native Grok Build CLI',
          adjustableEffort: true,
        })),
      worker: { defaultId: () => grokDefaultWorkerModel(models) },
      harness,
      displayTools: GROK_TOOLS,
      validatePermissions: grokPermissionPolicy,
      usage: grokUsageReader(),
    };
  },
  commands: {
    '--grok-models': {
      help: 'list the Grok Build catalog (native login required)',
      async run() {
        console.log(JSON.stringify(await discoverGrokModels(), null, 2));
      },
    },
  },
  environment: {
    MULTI_GROK_MODELS: 'comma-separated Grok model IDs to show, leaving other providers unchanged',
  },
  account: {
    verb: 'login',
    run(args, { run }) {
      if (args.length) {
        throw new Error('Unsupported login arguments');
      }
      // Grok Build owns its own browser and device-code flows; never proxy them.
      return run('grok', ['login']);
    },
  },
};

export default adapter;

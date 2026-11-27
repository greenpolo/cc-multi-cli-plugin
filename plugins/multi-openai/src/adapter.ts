import { mergePermissions } from '../../multi-core/src/gateway/harness-settings.ts';
import type { ProviderAdapter } from '../../multi-core/src/gateway/provider-adapter.ts';
import { OPENAI_SIGNATURE_PREFIX } from '../../multi-core/src/gateway/responses.ts';
import { CodexHarness } from './harness.ts';
import {
  type CodexModel,
  codexDefaultWorkerModel,
  codexFallbackModel,
  codexPickerOptions,
  discoverCodex,
} from './models.ts';
import { codexPermissionPolicy } from './permissions.ts';
import { CODEX_TOOLS } from './progress.ts';
import { codexUsageReader } from './usage-adapter.ts';

/** Codex's own login and catalog decide whether the rows exist. */
async function connectCodex(env: NodeJS.ProcessEnv): Promise<CodexModel[]> {
  try {
    const { signedIn, models } = await discoverCodex({ env });
    if (signedIn) {
      return models;
    }
    console.error('OpenAI choices unavailable: sign in with codex login to enable them.');
  } catch (error) {
    console.error(
      `OpenAI choices unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return [];
}

const adapter: ProviderAdapter = {
  // Sessions from before GPT ran through Codex still carry these in Claude's history.
  signaturePrefixes: [OPENAI_SIGNATURE_PREFIX],
  async connect({ env, harnessSettings }) {
    const models = await connectCodex(env);
    if (!models.length) {
      // Read even when signed out, so the usage pane reports the failed login itself.
      return { rows: () => [], usage: codexUsageReader(env) };
    }
    const harness = new CodexHarness(models, {
      checkPermissions: async (cwd, context) =>
        codexPermissionPolicy(mergePermissions(context, await harnessSettings(cwd))),
    });
    const fallbackModel = codexFallbackModel(models);
    return {
      rows: (fullCatalog) =>
        codexPickerOptions(models, fullCatalog).map(({ model, label, description }) => ({
          model,
          label,
          description: description ? `${description} · Codex CLI` : 'Native Codex CLI',
          adjustableEffort: true,
        })),
      worker: { defaultId: () => codexDefaultWorkerModel(models) },
      ...(fallbackModel ? { fallbackModel } : {}),
      harness,
      displayTools: CODEX_TOOLS,
      usage: codexUsageReader(env),
    };
  },
  account: {
    verb: 'login',
    run(args, { run }) {
      if (!args.every((arg) => arg === '--device-auth')) {
        throw new Error('Unsupported login arguments');
      }
      // Codex owns its login, its credential store and its refresh.
      return run('codex', ['login', ...args]);
    },
  },
};

export default adapter;

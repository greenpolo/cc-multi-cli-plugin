import type { ProviderAdapter } from '../../multi-core/src/gateway/provider-adapter.ts';
import { CursorHarness } from './harness.ts';
import {
  CURSOR_DEFAULT_WORKER_MODEL,
  type CursorModelOption,
  cursorModelOptions,
  cursorPickerOptions,
} from './models.ts';
import { assertCursorToolRules, cursorPermissionPolicy } from './permissions.ts';
import { CURSOR_TOOLS } from './progress.ts';
import { cursorUsageReader } from './usage-adapter.ts';
import { CursorWorkspaces } from './workspaces.ts';

/** The account's models; a failed listing only fails a caller that `required` it. */
async function discover(env: NodeJS.ProcessEnv, required: boolean) {
  const { Cursor } = await import('@cursor/sdk');
  const signedIn =
    Boolean(env.CURSOR_API_KEY) || (await Cursor.auth.status()).status === 'logged-in';
  let models: CursorModelOption[] = [];
  if (signedIn) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cursor model discovery timed out')), 15000);
      });
      models = cursorModelOptions(await Promise.race([Cursor.models.list(), timeout]));
    } catch (error) {
      if (required) {
        throw error;
      }
      console.error(
        `Cursor choices unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return { models, signedIn };
}

const adapter: ProviderAdapter = {
  async connect({ env, harnessSettings }) {
    const { models } = await discover(env, false);
    if (!models.length) {
      return undefined;
    }
    const harness = new CursorWorkspaces(
      (cwd) =>
        new CursorHarness(models, {
          cwd,
          checkPermissions: () =>
            harnessSettings(cwd, cursorPermissionPolicy, assertCursorToolRules),
        }),
    );
    return {
      rows: (fullCatalog) =>
        (fullCatalog ? models : cursorPickerOptions(models, env.MULTI_CURSOR_EXTRA_MODELS)).map(
          ({ model, label, description, catalog }) => ({
            model,
            label,
            description,
            adjustableEffort:
              catalog.parameters?.some(({ id }) => ['effort', 'reasoning_effort'].includes(id)) ??
              false,
          }),
        ),
      worker: { defaultId: () => CURSOR_DEFAULT_WORKER_MODEL },
      harness,
      displayTools: CURSOR_TOOLS,
      validatePermissions: cursorPermissionPolicy,
      checkRules: assertCursorToolRules,
      usage: cursorUsageReader(harness),
      billed: {
        scope: 'Cursor native agent lifetime; local billing entries are per turn',
        read: (session) => harness.billedUsageForSession(session),
      },
    };
  },
  commands: {
    '--cursor-login': {
      help: 'official Cursor SDK browser sign-in',
      async run() {
        const { Cursor } = await import('@cursor/sdk');
        await Cursor.auth.login({
          apiKeyName: 'cc-multi-cli',
          onLoginUrl: (url) => console.log(`Cursor login: ${url}`),
        });
        console.log('Cursor SDK login saved. Launch the gateway normally to use it.');
      },
    },
    '--cursor-models': {
      help: 'list account model choices',
      async run() {
        const { models, signedIn } = await discover(process.env, true);
        if (!signedIn) {
          throw new Error('Run with --cursor-login first.');
        }
        console.log(
          JSON.stringify(
            models.map(({ model, label, selection }) => ({ model, label, selection })),
            null,
            2,
          ),
        );
      },
    },
  },
  environment: {
    MULTI_CURSOR_EXTRA_MODELS:
      'comma-separated Cursor model IDs to add to Auto, Grok 4.7, and Composer 2.5 in /model',
  },
  account: {
    verb: 'login',
    run(args, { launcher }) {
      if (args.length) {
        throw new Error('Unsupported login arguments');
      }
      return launcher('--cursor-login');
    },
  },
};

export default adapter;

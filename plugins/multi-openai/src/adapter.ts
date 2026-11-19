import os from 'node:os';
import path from 'node:path';
import type { ProviderAdapter } from '../../multi-core/src/gateway/provider-adapter.ts';
import { createOpenAIReviewer, discoverOpenAIReviewer } from './approval.ts';
import { readCodexAuth } from './auth.ts';
import { openaiSignaturePrefixes, prepareOpenAIRequest } from './gateway-request.ts';
import { MODELS, OPENAI_DEFAULT_WORKER_MODEL, OPENAI_WORKER_EFFORT } from './models.ts';
import { openAIUsageReader } from './usage-adapter.ts';

/** Codex's own login decides whether the rows exist; the reviewer is looked for separately. */
async function signIn(authFile: string) {
  try {
    await readCodexAuth(authFile);
  } catch {
    console.error('OpenAI choices unavailable: sign in with codex login to enable them.');
    return { signedIn: false, reviewed: false };
  }
  let reviewed = false;
  try {
    reviewed = await discoverOpenAIReviewer(authFile);
  } catch {
    /* Missing capability leaves auto mode unreviewed; inference remains available. */
  }
  if (!reviewed) {
    console.error('OpenAI reviewer unavailable; actions in auto mode run unreviewed.');
  }
  return { signedIn: true, reviewed };
}

const adapter: ProviderAdapter = {
  signaturePrefixes: openaiSignaturePrefixes,
  async connect({ cwd, env }) {
    const authFile = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    const { signedIn, reviewed } = await signIn(authFile);
    return {
      rows: () =>
        Object.values(signedIn ? MODELS : {}).map((model) => ({
          model: `multi/openai/${model}`,
          label: model,
          description: 'OpenAI subscription · native Claude Code harness',
          adjustableEffort: true,
        })),
      worker: { defaultId: () => OPENAI_DEFAULT_WORKER_MODEL, effort: OPENAI_WORKER_EFFORT },
      fallbackModel: `multi/openai/${MODELS['openai-luna']}`,
      prepare: (input, model) => prepareOpenAIRequest(input, model, authFile),
      reviewer: reviewed
        ? {
            review: await createOpenAIReviewer(authFile, cwd),
            label: 'OpenAI',
            model: 'codex-auto-review',
          }
        : undefined,
      // Read even when signed out, so the usage pane reports the failed login itself.
      usage: openAIUsageReader(authFile),
    };
  },
  account: {
    verb: 'login',
    run(args, { run }) {
      if (!args.every((arg) => arg === '--device-auth')) {
        throw new Error('Unsupported login arguments');
      }
      return run('codex', ['-c', 'cli_auth_credentials_store=file', 'login', ...args]);
    },
  },
};

export default adapter;

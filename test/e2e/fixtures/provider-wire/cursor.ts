import { appendFile } from 'node:fs/promises';
import path from 'node:path';

export function getDefaultSdkAuthPath() {
  throw new Error('Unscripted Cursor credential access');
}

export const Cursor = {
  auth: { status: async () => ({ status: 'logged-in' }) },
  models: {
    list: async () => [
      {
        id: 'e2e-cursor',
        displayName: 'E2E Cursor',
        parameters: [{ id: 'fast', values: [{ value: 'false' }] }],
      },
    ],
  },
};

export const Agent = {
  create: async () => ({
    agentId: 'cursor-routing-agent',
    close() {},
    send: async (prompt: unknown, options: unknown) => {
      await appendFile(
        path.join(process.cwd(), 'cursor-requests.jsonl'),
        `${JSON.stringify({ prompt, options })}\n`,
      );
      return {
        id: 'cursor-routing-run',
        cancel() {},
        wait: async () => ({ status: 'finished', result: 'NATIVE_ROUTED_ONCE' }),
      };
    },
  }),
};

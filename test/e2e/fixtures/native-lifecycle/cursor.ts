import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { changedPrompt, deliver, readWire } from './probe.ts';

let nextAgent = 0;
let nextRun = 0;
const log = (event: object) =>
  appendFile(
    path.join(process.env.HOME ?? '', 'cursor-events.jsonl'),
    `${JSON.stringify(event)}\n`,
  );

export const Cursor = {
  auth: { status: async () => ({ status: 'logged-in' }) },
  models: {
    list: async () => [
      {
        id: 'e2e-model',
        displayName: 'E2E Model',
        parameters: [{ id: 'fast', values: [{ value: 'false' }] }],
      },
    ],
  },
};

function agent(agentId: string) {
  return {
    agentId,
    close() {},
    async send(prompt: unknown, options: { model: unknown }) {
      const id = `run-${++nextRun}`;
      await log({ type: 'send', agentId, id, prompt, model: options.model });
      if (process.env.MULTI_E2E_CURSOR_BUSY === '1') {
        const wire = await readWire(process.env.HOME ?? '');
        const probe = await deliver(
          wire,
          changedPrompt(wire, 'Different concurrent native prompt.'),
        );
        await log({ type: 'busy-response', ...probe });
      }
      return {
        id,
        cancel: async () => log({ type: 'cancel', agentId, id }),
        wait: async () => ({ status: 'finished', result: 'Native Cursor turn complete.' }),
      };
    },
  };
}

export const Agent = {
  async create(options: unknown) {
    const agentId = `cursor-e2e-${++nextAgent}`;
    await log({ type: 'create', agentId, options });
    return agent(agentId);
  },
  async resume(agentId: string, options: unknown) {
    await log({ type: 'resume', agentId, options });
    return agent(agentId);
  },
};

export function getDefaultSdkAuthPath() {
  return path.join(process.env.HOME ?? '', 'cursor-auth.json');
}

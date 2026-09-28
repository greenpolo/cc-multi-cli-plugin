let next = 0;
export const Cursor = {
  auth: { status: async () => ({ status: 'logged-in' }) },
  models: {
    list: async () => [
      {
        id: 'e2e',
        displayName: 'E2E Cursor',
        parameters: [{ id: 'fast', values: [{ value: 'false' }] }],
      },
    ],
  },
};
function agent(agentId) {
  return {
    agentId,
    close() {},
    send() {
      return {
        id: `run-${agentId}`,
        cancel() {},
        wait: async () => ({
          status: 'finished',
          result: 'Cursor worker complete.',
          usage: { inputTokens: 11, outputTokens: 7 },
        }),
      };
    },
    getUsage: async () => ({
      usage: { inputTokens: 11, outputTokens: 7 },
      cost: { totalCents: 2 },
      runs: [],
    }),
  };
}
export const Agent = {
  create: async () => agent(`cursor-e2e-${++next}`),
  resume: async (id) => agent(id),
};
export function getDefaultSdkAuthPath() {
  return `${process.env.HOME}/.cursor/sdk/auth.json`;
}

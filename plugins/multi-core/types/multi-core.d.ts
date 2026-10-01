// The values multi-core's hooks keep in `$.state`: held by the host for the session,
// so they survive a hot reload of the hooks module, and a drawing that reads one is
// drawn again when it is written. Plain JSON data; a field without a value is left out.
export type MultiCorePrompt = { sessionId: string; cwd: string; permissionMode?: string };

/** The prompt-boundary snapshot the gateway holds this session's mode generation for. */
export type MultiCorePolicy = {
  generation?: number;
  prompt?: MultiCorePrompt;
  harnessReady?: boolean;
  /** The snapshot last posted for a prompt that needs no harness policy, so an unchanged one posts nothing. */
  posted?: string;
  /** The session the gateway was greeted for (`session.start`, or the first prompt after a `/clear`). */
  handshake?: string;
};

export type MultiCoreDisplayTools = { registered: string[]; revision?: number };

export type MultiCoreUsagePane = {
  updatedAt: string;
  providers: Array<{
    id: string;
    name: string;
    status: string;
    summary: string;
    details: string[];
    url?: string;
  }>;
  receiptLines?: string[];
  error?: string;
  quotaAdviceEnabled?: boolean;
};

declare module 'claude-code' {
  interface PluginState {
    'multi-core': {
      policy: MultiCorePolicy;
      /** The model each loop last stepped on or was registered with, by agent id (`main` for the main loop). */
      agentModels: Record<string, string>;
      /** The model a provider worker resolved to, by its Agent call's tool_use_id. */
      spawnModels: Record<string, string>;
      /** Agent types positively classified as Claude-loop on a Claude model. */
      claudeTypes: string[];
      /** Provider (multi-*) worker types the model is offered. */
      offeredProviders: string[];
      displayTools: MultiCoreDisplayTools;
      /** The usage pane's props, by session id. */
      usagePanes: Record<string, MultiCoreUsagePane>;
      /** Sessions whose Agent calls carry the quota advice. */
      advisorySessions: string[];
    };
  }
}

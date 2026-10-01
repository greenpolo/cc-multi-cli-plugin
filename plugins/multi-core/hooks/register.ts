import type { EngineInterface, Register } from 'claude-code';
import { atom, read, update } from 'claude-code';
import type { MultiCoreDisplayTools, MultiCorePolicy } from '../types/multi-core.d.ts';
import { register as registerCompaction } from './compact.ts';
import { isActive, postJson, type Wire } from './gateway.ts';
import { register as registerLifecycle } from './lifecycle.ts';
import { type PromptSnapshot, policyClient, recordPrompt, snapshotKey } from './policy.ts';
import { isHarnessModel, isMultiModel } from './provider.ts';
import {
  callDisplayRow,
  isDisplayTool,
  type RowsClient,
  register as registerRows,
  syncDisplayTools,
} from './rows.ts';
import { defined } from './state.ts';
import { register as registerUsage } from './usage.ts';
import { register as registerWorkers } from './workers.ts';

const modKeys = atom(
  { plugin: 'multi-core', key: 'modKeys' } as const,
  {} as Record<string, string>,
);

const wire = ($: EngineInterface): Wire => ({
  url: () => $.env.get('MULTI_MOD_GATEWAY_URL'),
  token: () => $.env.get('MULTI_GATEWAY_TOKEN'),
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  keys: { read: () => read($, modKeys), save: (change) => update($, modKeys, change) },
});

// State values are named where they are read: the engine's scan reads an atom's plugin and key
// from this file's own source, not across an import.
const policy = atom({ plugin: 'multi-core', key: 'policy' } as const, {} as MultiCorePolicy);
const agentModels = atom(
  { plugin: 'multi-core', key: 'agentModels' } as const,
  {} as Record<string, string>,
);
const displayTools = atom(
  { plugin: 'multi-core', key: 'displayTools' } as const,
  { registered: [] } as MultiCoreDisplayTools,
);

const rowsClient = ($: EngineInterface): RowsClient => ({
  wire: wire($),
  sessionId: () => $.session.id(),
  held: () => read($, displayTools),
  save: (change) => update($, displayTools, change),
  register: (tool) => $.tool.register(tool),
});

type PromptEvent = { session_id: string; cwd: string; permission_mode?: string };

// Claude Code 2.1.272 loads exactly one entry from hooks.json `modules`; compose here.
// What the hooks keep lives in `$.state` (`state.ts`), so a hot reload loses none of it.
export const register: Register = (on, options) => {
  registerUsage(on, options);
  registerLifecycle(on, options);
  registerCompaction(on, options);
  registerWorkers(on, options);
  registerRows(on);
  // One hook for every tool call (a module hooks an event once without a matcher): a
  // display row is answered here, any other call is attributed to its provider's reviewer.
  on('tool.call', async ($, event, next) => {
    if (isDisplayTool(event.tool)) {
      return callDisplayRow(rowsClient($), event);
    }
    await attributeToolCall($, event);
    return next(event);
  });
  on('session.start', async ($, event, next) => {
    if (!(await isActive(wire($)))) {
      return next(event);
    }
    await $.command.register({
      name: 'multi-usage',
      description: 'Open provider quotas, spend, and session receipts.',
      immediate: true,
    });
    await greet($, await $.session.id(), await $.session.cwd());
    return next(event);
  });
  on('classic.UserPromptSubmit', async ($, event, next) => {
    await recordSnapshot($, event);
    return next(event);
  });
  on('classic.SessionStart', async ($, event, next) => {
    if (typeof event.permission_mode === 'string') {
      await recordSnapshot($, event);
    }
    return next(event);
  });
};

/**
 * The gateway's first record of a session (which also tells the launcher the mod is
 * live). `/clear` ends a session and starts another in the process without a
 * `session.start`, and `session.end` made the gateway forget the first, so the next
 * prompt greets it again before recording its snapshot.
 */
async function greet($: EngineInterface, sessionId: string, cwd: string) {
  const response = await postJson(wire($), '/multi/mod/session', {
    sessionId,
    cwd,
    model: await $.session.model(),
    event: 'start',
  });
  await update($, policy, (held) =>
    defined({
      ...held,
      generation: typeof response?.generation === 'number' ? response.generation : undefined,
      handshake: sessionId,
    }),
  );
}

/**
 * Records the prompt-boundary snapshot: the permission mode and workspace every
 * provider reads. A harness prompt waits for its translated settings policy; any other
 * model's snapshot is posted only when it differs from the one the gateway holds, so
 * ordinary Claude turns cost no round trip. The snapshot is always kept here, because a
 * harness worker spawned later admits against it.
 */
async function recordSnapshot($: EngineInterface, event: PromptEvent) {
  if (!(await isActive(wire($)))) {
    return;
  }
  const held = await read($, policy);
  if (held.handshake !== event.session_id) {
    await greet($, event.session_id, event.cwd);
  }
  const prompt = snapshotOf(event);
  const model = await $.session.model();
  const current = await read($, policy);
  const harness = isHarnessModel(model);
  const key = snapshotKey(prompt, model);
  let generation = current.generation;
  let posted: string | undefined;
  if (harness || current.posted !== key || generation === undefined) {
    generation = await recordPrompt(policyClient(wire($), model), prompt, generation);
    posted = harness || generation === undefined ? undefined : key;
  } else {
    posted = key;
  }
  await update($, policy, (latest) =>
    defined<MultiCorePolicy>({
      ...latest,
      prompt,
      generation,
      posted,
      harnessReady: harness && generation !== undefined,
    }),
  );
  if (harness) {
    // The display rows of this prompt's native run anchor only once their tools exist.
    await syncDisplayTools(rowsClient($));
  }
}

function snapshotOf(event: PromptEvent): PromptSnapshot {
  return defined({
    sessionId: event.session_id,
    cwd: event.cwd,
    permissionMode: event.permission_mode,
  });
}

/**
 * Reviewer attribution for a provider's tool call: the gateway learns the session, call,
 * and workspace it needs to match the reviewer request to it. A Claude loop's tool call
 * is Claude's own and costs no gateway call. The reply never decides the call. It runs
 * from `tool.call`, which carries the calling loop's agentId (`classic.PreToolUse` does
 * not, so it could not tell a provider worker's call from the session's own).
 */
async function attributeToolCall(
  $: EngineInterface,
  event: { tool: string; tool_use_id?: string; agentId?: string },
) {
  try {
    const model =
      event.agentId === undefined
        ? await $.session.model()
        : (await read($, agentModels))[event.agentId];
    if (!isMultiModel(model) || !(await isActive(wire($)))) {
      return;
    }
    // The engine hands a tool call no permission mode: the prompt-boundary snapshot has it.
    const mode = (await read($, policy)).prompt?.permissionMode;
    await postJson(wire($), '/multi/permission', {
      session_id: await $.session.id(),
      tool_use_id: event.tool_use_id,
      tool_name: event.tool,
      cwd: await $.session.cwd(),
      ...(mode === undefined ? {} : { permission_mode: mode }),
    });
  } catch {
    // Attribution is best effort; Claude's own checks decide the call.
  }
}

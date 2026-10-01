import type { EngineInterface, Register, Timer } from 'claude-code';
import { atom, read, update } from 'claude-code';
import type {
  MultiCoreDisplayTools,
  MultiCorePolicy,
  MultiCoreUsagePane,
} from '../types/multi-core.d.ts';
import { forgetKey, getJson, isActive, postJson, type Wire } from './gateway.ts';
import { isHarnessModel, isMultiModel } from './provider.ts';
import { type RowsClient, syncDisplayTools } from './rows.ts';
import { withBounded } from './state.ts';

// State values are named where they are read: the engine's scan reads an atom's plugin and key
// from this file's own source, not across an import.
const policy = atom({ plugin: 'multi-core', key: 'policy' } as const, {} as MultiCorePolicy);
const agentModels = atom(
  { plugin: 'multi-core', key: 'agentModels' } as const,
  {} as Record<string, string>,
);
const spawnModels = atom(
  { plugin: 'multi-core', key: 'spawnModels' } as const,
  {} as Record<string, string>,
);
const claudeTypes = atom({ plugin: 'multi-core', key: 'claudeTypes' } as const, [] as string[]);
const offeredProviders = atom(
  { plugin: 'multi-core', key: 'offeredProviders' } as const,
  [] as string[],
);
const displayTools = atom(
  { plugin: 'multi-core', key: 'displayTools' } as const,
  { registered: [] } as MultiCoreDisplayTools,
);
const usagePanes = atom(
  { plugin: 'multi-core', key: 'usagePanes' } as const,
  {} as Record<string, MultiCoreUsagePane>,
);
const advisorySessions = atom(
  { plugin: 'multi-core', key: 'advisorySessions' } as const,
  [] as string[],
);

const rowsClient = ($: EngineInterface): RowsClient => ({
  wire: wire($),
  sessionId: () => $.session.id(),
  held: () => read($, displayTools),
  save: (change) => update($, displayTools, change),
  register: (tool) => $.tool.register(tool),
});

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

type Status = {
  model?: string;
  state?: string;
  detail?: string;
  error?: string;
  elapsedMs?: number;
  startedAt?: number;
  [field: string]: unknown;
};

/** A harness loop's status poll: a timer on `$.clock`, so it ends with its environment. */
type Poll = { timer: Timer; since: number; failures: number; isBusy: boolean };

const pollMs = 500;
const maximumPolls = 128;
const maximumFailures = 5;
/** The polls of this module instance; a hot reload cancels the timers with it. */
const polls = new Map<string, Poll>();

function stopPoll(key: string): boolean {
  const poll = polls.get(key);
  poll?.timer.cancel();
  return polls.delete(key);
}

async function startPoll($: EngineInterface, key: string, agentId: string | undefined) {
  if (polls.has(key) || polls.size >= maximumPolls) {
    return;
  }
  const poll: Poll = {
    since: await $.clock.now(),
    failures: 0,
    isBusy: false,
    timer: $.clock.every(pollMs, () => {
      void tick($, key, agentId);
    }),
  };
  polls.set(key, poll);
}

/** One status read; a tick still in flight when the next is due is skipped. */
async function tick($: EngineInterface, key: string, agentId: string | undefined) {
  const poll = polls.get(key);
  if (!poll || poll.isBusy) {
    return;
  }
  poll.isBusy = true;
  try {
    const status = await getJson<Status>(wire($), '/multi/mod/lifecycle', {
      sessionId: await $.session.id(),
      agentId: agentId ?? 'main',
    });
    if (polls.get(key) !== poll) {
      return;
    }
    poll.failures = status && !status.refused ? 0 : poll.failures + 1;
    if (status?.state && (status.startedAt ?? 0) >= poll.since) {
      $.ui.status(statusText(status, agentId));
      if (status.state !== 'running') {
        stopPoll(key);
      }
    }
    if (poll.failures >= maximumFailures) {
      stopPoll(key);
    }
  } finally {
    poll.isBusy = false;
  }
}

async function prepareStep(
  $: EngineInterface,
  event: { agentId?: string; model: string; effort?: unknown },
) {
  const key = event.agentId ?? 'main';
  const known = (await read($, agentModels))[key];
  if (known !== event.model) {
    await update($, agentModels, (held) => withBounded(held, key, event.model));
  }
  if (isMultiModel(event.model)) {
    // The gateway reads a Multi request's model and effort from this record, so it is
    // sent before the request; a Claude step costs the gateway nothing.
    await postJson(wire($), '/multi/mod/telemetry', {
      ...event,
      sessionId: await $.session.id(),
    });
  }
  if (isHarnessModel(event.model)) {
    await startPoll($, key, event.agentId);
    // A harness may announce a tool the mod has not registered; register it
    // before the step's request, so the rows of later runs can anchor.
    await syncDisplayTools(rowsClient($));
  }
}

export const register = (on: Parameters<Register>[0], _options: Parameters<Register>[1]) => {
  on('turn.step', async function* ($, event, next) {
    await prepareStep($, event);
    return yield* next(event);
  });
  on('turn.complete', async ($, event, next) => {
    const key = event.agentId ?? 'main';
    const model = (await read($, agentModels))[key];
    if (isMultiModel(model)) {
      await postJson(wire($), '/multi/mod/usage/complete', {
        sessionId: await $.session.id(),
        agentId: event.agentId,
        turnId: event.turnId,
        outcome: event.reason,
      });
    }
    const wasRunning = stopPoll(key);
    // Retain a child's identity between turns: compaction can precede its next step.
    if (event.isAborted && isHarnessModel(model)) {
      await postJson(wire($), '/multi/mod/compact/cancel', {
        sessionId: await $.session.id(),
        agentId: event.agentId,
      });
    }
    if (wasRunning && polls.size === 0) {
      $.ui.status(undefined);
    }
    return next(event);
  });
  // The session is over for good: a `/clear` or a resume ends one and starts another in
  // the same process (`session.start` fires for neither), and the gateway forgets the
  // ended one. `session.detach` fires when any client leaves the roster, a session still
  // running, so it is not a place to forget anything.
  on('session.end', async ($, event, next) => {
    for (const key of [...polls.keys()]) {
      stopPoll(key);
    }
    await forgetSession($, event.sessionId, next.signal);
    return next(event);
  });
};

/** Forgets everything the hooks held for the session that ended, here and in the gateway. */
async function forgetSession($: EngineInterface, sessionId: string, signal: AbortSignal) {
  await update($, policy, () => ({}));
  await update($, agentModels, () => ({}));
  await update($, spawnModels, () => ({}));
  await update($, claudeTypes, () => []);
  await update($, offeredProviders, () => []);
  await update($, displayTools, () => ({ registered: [] }));
  await update($, advisorySessions, (held) => held.filter((id) => id !== sessionId));
  await update($, usagePanes, (held) => {
    const { [sessionId]: _closed, ...others } = held;
    return others;
  });
  $.ui.status(undefined);
  if (await isActive(wire($))) {
    await postJson(wire($), '/multi/mod/detach', { sessionId }, { timeoutMs: 1000, signal });
  }
  // After the detach, which the gateway admits only with the key.
  await forgetKey(wire($), sessionId);
}

function statusText(status: Status, agentId: string | undefined) {
  const elapsed = Math.floor((status.elapsedMs ?? 0) / 1000);
  // A failed or refused run names its reason, so the line says why, not only that.
  return `${status.model} · ${agentId ?? 'main'} · ${status.state} · ${elapsed}s ${status.error ?? status.detail ?? ''}`;
}

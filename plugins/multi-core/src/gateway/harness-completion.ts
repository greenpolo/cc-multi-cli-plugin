import path from 'node:path';
import type { HarnessExchange } from './harness-exchange.ts';
import type { HarnessResponse } from './harness-response.ts';
import {
  atomicJson,
  type HarnessSession,
  type HarnessSessionBase,
  type HarnessSessionStore,
} from './harness-session.ts';
import type { Emit, MessagesResponse } from './messages.ts';

/**
 * Records a completed native turn before its terminal stream events are visible.
 * Providers retain ownership of their state mutation; this helper owns the
 * ordering that makes completion durable and replayable.
 */
export async function commitHarnessResponse<
  S extends HarnessSessionBase,
  R extends object,
  M extends object,
>(args: {
  session: HarnessSession<S, R>;
  store: HarnessSessionStore<S, R>;
  response: HarnessResponse;
  finished: MessagesResponse;
  exchange: HarnessExchange<M>;
  key: string;
  emit: Emit;
  update: (saved: S) => void;
  onCommitted?: () => void;
}): Promise<MessagesResponse> {
  const terminalEvents = args.response.takeTerminalEvents();
  const events = [
    ...args.exchange.events,
    ...terminalEvents.map(
      ([name, value]) => [name, structuredClone(value)] as [typeof name, typeof value],
    ),
  ];
  const before = structuredClone(args.session.saved);
  args.update(args.session.saved);
  args.session.saved.response = args.finished;
  args.session.saved.replay = { key: args.key, events };
  try {
    await args.store.save(args.session);
  } catch (error) {
    restoreSaved(args.session.saved, before);
    throw error;
  }
  args.onCommitted?.();
  for (const event of terminalEvents) {
    args.emit(...event);
  }
  return args.finished;
}

function restoreSaved<S extends HarnessSessionBase>(target: S, source: S): void {
  for (const key of Object.keys(target)) {
    delete (target as Record<string, unknown>)[key];
  }
  Object.assign(target, source);
}

/** Archives the last durable answer before a later native turn can overwrite it. */
export async function archiveHarnessReply<S extends HarnessSessionBase, R extends object>(args: {
  session: HarnessSession<S, R>;
  stateDirectory: string;
  platform: NodeJS.Platform;
}): Promise<void> {
  const { replay, response } = args.session.saved;
  if (!replay || !response) {
    return;
  }
  await atomicJson(
    path.join(args.stateDirectory, `${replay.key}.response.json`),
    { response, events: replay.events },
    args.platform,
  );
}

import { readdir, rm, stat } from 'node:fs/promises';
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
  /** Archives kept beyond the one just written; defaults to `archiveKeepCount`. */
  keep?: number;
  maxAgeMs?: number;
  now?: number;
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
  await pruneArchives(args.stateDirectory, {
    keep: args.keep ?? archiveKeepCount,
    maxAgeMs: args.maxAgeMs ?? archiveMaxAgeMs,
    now: args.now ?? Date.now(),
  });
}

/**
 * Only a client retry of a just-superseded turn can ask for an archive, so a
 * short window is enough; the files hold native tool output and must not
 * accumulate without bound.
 */
export const archiveKeepCount = 32;
export const archiveMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

/** Best effort: a failure to prune never fails the turn that triggered it. */
export async function pruneArchives(
  directory: string,
  limits: { keep: number; maxAgeMs: number; now: number },
): Promise<void> {
  try {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.response.json'));
    const dated = await Promise.all(
      names.map(async (name) => {
        const file = path.join(directory, name);
        const info = await stat(file).catch(() => undefined);
        return info ? { file, time: info.mtimeMs } : undefined;
      }),
    );
    const present = dated
      .filter((entry): entry is { file: string; time: number } => entry !== undefined)
      .sort((left, right) => right.time - left.time);
    const doomed = present.filter(
      (entry, index) => index >= limits.keep || limits.now - entry.time > limits.maxAgeMs,
    );
    await Promise.all(doomed.map((entry) => rm(entry.file, { force: true }).catch(() => {})));
  } catch {
    // Pruning is housekeeping only.
  }
}

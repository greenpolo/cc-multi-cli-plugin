import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { archiveHarnessReply } from './harness-completion.ts';
import { ExchangeRegistry, type HarnessExchange, replayPersisted } from './harness-exchange.ts';
import { classifyHarnessFailure } from './harness-failure.ts';
import type { NativeProgressObserver } from './harness-progress.ts';
import {
  type HarnessSession,
  type HarnessSessionBase,
  HarnessSessionStore,
} from './harness-session.ts';
import type { Emit, MessagesRequest, MessagesResponse } from './messages.ts';
import type { PermissionContext } from './mode-hook.ts';
import { abortGraceMs } from './settle.ts';

const MAX_CONCURRENT_EXCHANGES = 256;

export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Waits for `operation`, but never longer than `timeoutMs`; it never rejects on timeout. */
export async function boundedWait(operation: Promise<unknown>, timeoutMs = abortGraceMs) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The failure a CLI harness reports: a one-line message capped at 500 characters, and
 * the status the shared policy gives it. `advise` may append provider guidance.
 */
export function harnessFailure(
  error: unknown,
  fallback: string,
  advise?: (reported: string) => string | undefined,
): { status: number; message: string } {
  const detail = error && typeof error === 'object' && 'message' in error ? error.message : error;
  const reported = String(detail ?? fallback);
  const advice = advise?.(reported);
  const message = `${reported}${advice ? ` ${advice}` : ''}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return { status: classifyHarnessFailure(error).status, message };
}

/** Everything one native turn is addressed by, fixed before the exchange starts. */
export type CliTurn<Selection> = {
  body: MessagesRequest;
  context: PermissionContext;
  selection: Selection;
  cwd: string;
  identity: string;
  key: string;
  observe?: NativeProgressObserver;
};

export type CliHarnessOptions<Saved extends HarnessSessionBase> = {
  /** Display name used in every message the caller reads. */
  tag: string;
  /** The persisted session discriminator and the leading element of the exchange key. */
  storeProvider: string;
  stateDirectory: string;
  defaultCwd: string;
  platform: NodeJS.Platform;
  version: number;
  fresh: (identity: string) => Saved;
  validate: (saved: Partial<Saved>) => boolean;
};

/**
 * The request, exchange, lease and shutdown flow shared by the CLI-backed harnesses
 * (Antigravity, Grok). A provider supplies its model selection, the request part of
 * the exchange key, its error type, and the turn itself.
 */
export abstract class CliHarness<Saved extends HarnessSessionBase, Selection> {
  protected readonly tag: string;
  protected readonly stateDirectory: string;
  protected readonly platform: NodeJS.Platform;
  protected readonly store: HarnessSessionStore<Saved>;
  private readonly storeProvider: string;
  private readonly defaultCwd: string;
  private readonly exchanges: ExchangeRegistry;
  private closed = false;

  constructor(options: CliHarnessOptions<Saved>) {
    this.tag = options.tag;
    this.storeProvider = options.storeProvider;
    this.stateDirectory = options.stateDirectory;
    this.defaultCwd = options.defaultCwd;
    this.platform = options.platform;
    this.exchanges = new ExchangeRegistry({ provider: options.tag, createMeta: () => ({}) });
    this.store = new HarnessSessionStore<Saved>({
      provider: options.storeProvider,
      tag: options.tag,
      stateDirectory: options.stateDirectory,
      platform: options.platform,
      version: options.version,
      runtime: () => ({}),
      fresh: options.fresh,
      validate: options.validate,
    });
  }

  protected abstract selection(body: MessagesRequest): Selection;

  /** The part of the exchange key that names the request itself, before permissions. */
  protected abstract requestKey(body: MessagesRequest): unknown;

  /** This provider's error for a failed turn; its `failure.status` follows the shared policy. */
  protected abstract providerError(error: unknown): Error;

  /** Runs one turn on a held session. Failures leave as this provider's own error. */
  protected abstract execute(
    turn: CliTurn<Selection>,
    session: HarnessSession<Saved>,
    exchange: HarnessExchange,
    emit: Emit,
  ): Promise<MessagesResponse>;

  abstract validate(body: MessagesRequest): number;

  /** The scope's last reply from its session record, located as `handle` locates it. */
  async recordedResponse(scope: string, context?: PermissionContext) {
    const cwd = await realpath(context?.cwd ?? this.defaultCwd);
    return this.store.recordedResponse(`${cwd}\0${scope}`);
  }

  async handle(
    body: MessagesRequest,
    scope: string,
    signal: AbortSignal,
    emit?: Emit,
    context?: PermissionContext,
    observe?: NativeProgressObserver,
  ): Promise<MessagesResponse> {
    if (this.closed) {
      throw new Error(`${this.tag} harness is closed`);
    }
    signal.throwIfAborted();
    if (!context) {
      throw new Error(`${this.tag} requires an explicit Claude permission context`);
    }
    const selection = this.selection(body);
    this.validate(body);
    const cwd = await realpath(context.cwd ?? this.defaultCwd);
    const identity = `${cwd}\0${scope}`;
    const key = digest([
      this.storeProvider,
      identity,
      this.requestKey(body),
      {
        permissionMode: context.permissionMode,
        tools: context.tools,
        disallowedTools: context.disallowedTools,
        nativePermissionError: context.nativePermissionError,
        compaction: context.compaction,
      },
    ]);
    const turn: CliTurn<Selection> = { body, context, selection, cwd, identity, key, observe };
    let exchange = this.exchanges.get(key);
    if (!exchange) {
      if (this.exchanges.size >= MAX_CONCURRENT_EXCHANGES) {
        throw new Error(`Too many concurrent ${this.tag} requests`);
      }
      exchange = this.exchanges.start(key, (started, forward) =>
        this.serve(turn, started, forward),
      );
    }
    return this.exchanges.observe(exchange, signal, emit);
  }

  private async serve(turn: CliTurn<Selection>, exchange: HarnessExchange, emit: Emit) {
    let lease: Awaited<ReturnType<HarnessSessionStore<Saved>['acquireLease']>>;
    try {
      // A first-load race is a deterministic conflict, so it must leave here as
      // this provider's own failure: a bare busy error reads as a retryable 502.
      lease = await this.store.acquireLease(turn.identity);
    } catch (error) {
      throw this.providerError(error);
    }
    const session = lease.session;
    try {
      const replayed = await replayPersisted({
        stateDirectory: this.stateDirectory,
        key: turn.key,
        saved: session.saved,
        emit,
        provider: this.tag,
      });
      if (replayed !== undefined) {
        return replayed;
      }
      await archiveHarnessReply({
        session,
        stateDirectory: this.stateDirectory,
        platform: this.platform,
      });
      return await this.execute(turn, session, exchange, emit);
    } finally {
      await lease.release();
      // The durable record holds everything; an idle attachment only pins its lock and replay events.
      await this.store.evictIdle(session);
    }
  }

  async close() {
    this.closed = true;
    const running: Promise<MessagesResponse>[] = [];
    for (const exchange of this.exchanges.all()) {
      if (!exchange.settled) {
        exchange.controller.abort(new Error(`${this.tag} gateway closed`));
        running.push(exchange.result);
      }
    }
    await boundedWait(Promise.allSettled(running));
    await this.store.closeAll();
  }
}

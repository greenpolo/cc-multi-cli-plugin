import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  archiveHarnessReply,
  commitHarnessResponse,
} from '../../multi-core/src/gateway/harness-completion.ts';
import type { HarnessExchange } from '../../multi-core/src/gateway/harness-exchange.ts';
import {
  ExchangeRegistry,
  replayPersisted,
} from '../../multi-core/src/gateway/harness-exchange.ts';
import {
  continuation,
  historyRewound,
  interruptedNotice,
  stderrDiagnostics,
  writeNotices,
} from '../../multi-core/src/gateway/harness-notices.ts';
import type { NativeProgressObserver } from '../../multi-core/src/gateway/harness-progress.ts';
import { NativeActionTracker } from '../../multi-core/src/gateway/harness-progress.ts';
import type { HarnessUsageFields } from '../../multi-core/src/gateway/harness-response.ts';
import { HarnessResponse } from '../../multi-core/src/gateway/harness-response.ts';
import type {
  HarnessSession,
  HarnessSessionBase,
} from '../../multi-core/src/gateway/harness-session.ts';
import {
  HarnessBusyError,
  HarnessSessionStore,
} from '../../multi-core/src/gateway/harness-session.ts';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
} from '../../multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';
import { abortGraceMs, settleOrAbort } from '../../multi-core/src/gateway/settle.ts';
import type { GrokRunOptions, GrokRunResult, GrokStreamEvent, GrokUsage } from './cli.ts';
import { GrokCliError, runGrok } from './cli.ts';
import { grokFailureAdvice } from './errors.ts';
import type { GrokModel } from './models.ts';
import { selectGrokModel } from './models.ts';
import { type GrokPolicy, grokCompactionPolicy } from './permissions.ts';
import { observeGrokEvent } from './progress.ts';
import { grokHistoryHash, prepareGrokRequest } from './request.ts';

export type GrokRunner = (options: GrokRunOptions) => Promise<GrokRunResult>;

export type CheckGrokPermissions = (cwd: string, context: PermissionContext) => Promise<GrokPolicy>;

/** Display tag used in exchange and replay messages, kept as today's messages spell it. */
const PROVIDER = 'Grok';
/** The persisted session discriminator; it is written to disk, so it stays as-is. */
const STORE_PROVIDER = 'grok';

type GrokSaved = HarnessSessionBase & {
  version: 1;
  /** Native session identity, chosen here so a durable run ID precedes any output. */
  sessionId?: string;
  /** Running total in USD, reported per invocation by the CLI. */
  cost?: number;
};
type GrokSession = HarnessSession<GrokSaved>;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class GrokHarness {
  private readonly models: readonly GrokModel[];
  private readonly defaultCwd: string;
  private readonly stateDirectory: string;
  private readonly platform: NodeJS.Platform;
  private readonly run: GrokRunner;
  private readonly checkPermissions: CheckGrokPermissions;
  private readonly store: HarnessSessionStore<GrokSaved>;
  private readonly exchanges = new ExchangeRegistry({
    provider: PROVIDER,
    createMeta: () => ({}),
  });
  private closed = false;

  constructor(
    models: readonly GrokModel[],
    {
      cwd = process.cwd(),
      stateDirectory = path.join(os.homedir(), '.grok', 'multi-harness'),
      run = runGrok,
      checkPermissions,
      platform = process.platform,
    }: {
      cwd?: string;
      stateDirectory?: string;
      run?: GrokRunner;
      checkPermissions?: CheckGrokPermissions;
      platform?: NodeJS.Platform;
    } = {},
  ) {
    this.models = models;
    this.defaultCwd = cwd;
    this.stateDirectory = stateDirectory;
    this.platform = platform;
    this.run = run;
    this.checkPermissions = checkPermissions ?? missingPermissions;
    this.store = new HarnessSessionStore<GrokSaved>({
      provider: STORE_PROVIDER,
      tag: PROVIDER,
      stateDirectory,
      platform,
      version: 1,
      runtime: () => ({}),
      fresh: (identity) => ({ version: 1, provider: STORE_PROVIDER, identity, interrupted: false }),
      validate: (saved) =>
        (saved.sessionId === undefined || isUuid(saved.sessionId)) &&
        (saved.cost === undefined || (typeof saved.cost === 'number' && saved.cost >= 0)),
    });
  }

  private selection(body: MessagesRequest) {
    return selectGrokModel(this.models, body.model, body.output_config?.effort);
  }

  validate(body: MessagesRequest) {
    const selection = this.selection(body);
    return prepareGrokRequest(body, selection.model.id).inputTokens;
  }

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
      throw new Error('Grok harness is closed');
    }
    signal.throwIfAborted();
    if (!context) {
      throw new Error('Grok requires an explicit Claude permission context');
    }
    const selection = this.selection(body);
    this.validate(body);
    const cwd = await realpath(context.cwd ?? this.defaultCwd);
    const identity = `${cwd}\0${scope}`;
    const key = digest([
      'grok',
      identity,
      {
        ...body,
        stream: undefined,
        messages: grokHistoryHash(body.messages),
        system: undefined,
      },
      {
        permissionMode: context.permissionMode,
        tools: context.tools,
        disallowedTools: context.disallowedTools,
        nativePermissionError: context.nativePermissionError,
        compaction: context.compaction,
      },
    ]);
    let exchange = this.exchanges.get(key);
    if (!exchange) {
      if (this.exchanges.size >= 256) {
        throw new Error('Too many concurrent Grok requests');
      }
      exchange = this.exchanges.start(key, (startedExchange, forward) =>
        this.serve(body, context, selection, cwd, identity, key, startedExchange, forward, observe),
      );
    }
    return this.exchanges.observe(exchange, signal, emit);
  }

  private async serve(
    body: MessagesRequest,
    context: PermissionContext,
    selection: ReturnType<typeof selectGrokModel>,
    cwd: string,
    identity: string,
    key: string,
    exchange: HarnessExchange,
    emit: Emit,
    observe?: NativeProgressObserver,
  ): Promise<MessagesResponse> {
    let lease: Awaited<ReturnType<HarnessSessionStore<GrokSaved>['acquireLease']>>;
    try {
      lease = await this.store.acquireLease(identity);
    } catch (error) {
      throw new GrokProviderError(error);
    }
    const session = lease.session;
    try {
      const replayed = await replayPersisted({
        stateDirectory: this.stateDirectory,
        key,
        saved: session.saved,
        emit,
        provider: PROVIDER,
      });
      if (replayed !== undefined) {
        return replayed;
      }
      await archiveHarnessReply({
        session,
        stateDirectory: this.stateDirectory,
        platform: this.platform,
      });
      return await this.execute(
        body,
        context,
        selection,
        cwd,
        session,
        key,
        exchange,
        emit,
        observe,
      );
    } finally {
      await lease.release();
    }
  }

  /**
   * Everything a turn needs before the CLI is invoked: the forwarded messages, the
   * checked policy, and a response primed with its opening notices. Split out of
   * `execute` to keep its own branching under the cognitive-complexity limit.
   */
  private async openTurn(
    body: MessagesRequest,
    context: PermissionContext,
    selection: ReturnType<typeof selectGrokModel>,
    cwd: string,
    session: GrokSession,
    wasInterrupted: boolean,
    emit: Emit,
  ): Promise<{
    prepared: ReturnType<typeof prepareGrokRequest>;
    policy: GrokPolicy;
    response: HarnessResponse;
  }> {
    // Computed only once the record is held, so a continuation error still releases
    // it in `execute`'s `finally` instead of leaving the session busy forever.
    const messages = session.saved.sessionId ? continuation(body, PROVIDER) : (body.messages ?? []);
    const rewound = historyRewound(session.saved, body.messages ?? [], grokHistoryHash);
    const prepared = prepareGrokRequest({ ...body, messages }, selection.model.id);
    // A run policy is always checked, so an unsupported mode fails before the CLI
    // starts; a compaction turn then replaces it with its own toolless policy.
    const checked = await this.checkPermissions(cwd, context);
    const policy = context.compaction === undefined ? checked : grokCompactionPolicy();
    const response = new HarnessResponse(
      body.model ?? selection.model.model,
      prepared.inputTokens,
      emit,
    );
    const policyIdentity = digest(policy);
    writeNotices(response, {
      tag: PROVIDER,
      interrupted: wasInterrupted,
      rewound,
      notice: policy.notice,
      noticeChanged: !session.saved.response || session.saved.policyIdentity !== policyIdentity,
    });
    session.saved.policyIdentity = policyIdentity;
    return { prepared, policy, response };
  }

  private async execute(
    body: MessagesRequest,
    context: PermissionContext,
    selection: ReturnType<typeof selectGrokModel>,
    cwd: string,
    session: GrokSession,
    key: string,
    exchange: HarnessExchange,
    emit: Emit,
    observe?: NativeProgressObserver,
  ): Promise<MessagesResponse> {
    const signal = exchange.controller.signal;
    const wasInterrupted = session.saved.interrupted;
    let started = false;
    try {
      const { prepared, policy, response } = await this.openTurn(
        body,
        context,
        selection,
        cwd,
        session,
        wasInterrupted,
        emit,
      );
      signal.throwIfAborted();
      const sessionId = session.saved.sessionId ?? randomUUID();
      let startSave: Promise<void> | undefined;
      const startedAt = performance.now();
      // Each finished tool call becomes a display row in this reply, named after
      // Grok's own tool; the terse summary is written when the run settles.
      const actions = new NativeActionTracker(PROVIDER, observe, (block) =>
        response.displayRow(block),
      );
      const onEvent = (event: GrokStreamEvent) => {
        if (!started) {
          started = true;
          // The native session now exists. Record it before the turn completes so
          // a crash resumes this conversation instead of starting a fresh one.
          session.saved.sessionId = sessionId;
          session.saved.interrupted = true;
          startSave = this.store.save(session).catch(() => {
            // The run continues regardless of a failed durability write.
          });
        }
        eventText(event, response, actions);
      };
      const outcome = await settleOrAbort(
        this.run({
          cwd,
          prompt: wasInterrupted
            ? `${interruptedNotice(PROVIDER)}\n\n${prepared.prompt}`
            : prepared.prompt,
          model: selection.model.id,
          ...(selection.effort ? { effort: selection.effort } : {}),
          ...(session.saved.sessionId
            ? { resume: session.saved.sessionId }
            : { session: sessionId }),
          mode: policy.mode,
          tools: policy.tools,
          disallowedTools: policy.disallowedTools,
          deny: policy.deny,
          forbiddenTools: policy.forbidden,
          signal,
          onEvent,
        }),
        signal,
        'Grok native run',
      );
      await startSave;
      return await this.settle(
        { session, response, outcome, selection, key, exchange, emit, actions },
        performance.now() - startedAt,
      );
    } catch (error) {
      // Traced before the rethrow: a failure that never reached the CLI left no
      // other evidence at all, which cost one diagnosis already.
      if (error instanceof GrokProviderError) {
        throw error;
      }
      // The run ended without a terminal result. If the CLI ever produced output the
      // native turn's completion is unknown, so the next request resumes and says so.
      if (started) {
        session.saved.interrupted = true;
        await this.store.save(session).catch(() => {
          // The run failure below is the more useful error to surface.
        });
      }
      throw new GrokProviderError(error);
    }
  }

  private async settle(
    run: {
      session: GrokSession;
      response: HarnessResponse;
      outcome: GrokRunResult;
      selection: ReturnType<typeof selectGrokModel>;
      key: string;
      exchange: HarnessExchange;
      emit: Emit;
      actions: NativeActionTracker;
    },
    elapsedMs: number,
  ): Promise<MessagesResponse> {
    const { session, response, outcome, selection, key, exchange, emit, actions } = run;
    const result = outcome.result;
    // The CLI owns the identity it reports; a mismatch would silently fork history.
    if (session.saved.sessionId !== undefined && result.sessionId !== session.saved.sessionId) {
      throw new GrokProviderError(
        `Grok answered on session ${result.sessionId} instead of ${session.saved.sessionId}`,
      );
    }
    response.text(actions.text(result.turns));
    appendDiagnostics(response, outcome, elapsedMs);
    const finished = response.finish(
      toHarnessUsage(result.usage),
      selection.model.id,
      selection.effort,
    );
    return commitHarnessResponse({
      session,
      store: this.store,
      response,
      finished,
      exchange,
      key,
      emit,
      update: (saved) => {
        saved.sessionId = result.sessionId;
        saved.interrupted = false;
        saved.cost = (saved.cost ?? 0) + (result.costUsd ?? 0);
      },
    });
  }

  async close() {
    this.closed = true;
    const running: Promise<MessagesResponse>[] = [];
    for (const exchange of this.exchanges.all()) {
      if (!exchange.settled) {
        exchange.controller.abort(new Error('Grok gateway closed'));
        running.push(exchange.result);
      }
    }
    await bounded(Promise.allSettled(running));
    await this.store.closeAll();
  }
}

/**
 * Assistant text streams; native tool calls become display rows.
 */
function eventText(
  event: GrokStreamEvent,
  response: HarnessResponse,
  actions: NativeActionTracker,
) {
  if (event.event === 'text') {
    response.text(event.text);
    return;
  }
  observeGrokEvent(event, actions);
}

function toHarnessUsage(usage: GrokUsage | undefined): HarnessUsageFields | undefined {
  if (usage === undefined) {
    return undefined;
  }
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheCreate: usage.cache_creation_input_tokens,
    reasoning: usage.reasoning_tokens,
    total: usage.total_tokens,
  };
}

/** The CLI reports cost per invocation, so it is shown as billed for this run. */
function appendDiagnostics(response: HarnessResponse, outcome: GrokRunResult, elapsedMs: number) {
  const parts = [];
  if (Number.isFinite(elapsedMs)) {
    parts.push(`completed in ${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s`);
  }
  if (outcome.result.costUsd !== undefined) {
    parts.push(`$${outcome.result.costUsd.toFixed(4)} billed`);
  }
  if (parts.length) {
    response.text(`\n[Grok] ${parts.join(' · ')}\n`);
  }
  const diagnostics = stderrDiagnostics(outcome.stderr);
  if (diagnostics) {
    response.text(`[Grok] ${diagnostics}\n`);
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
}

async function bounded(operation: Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, abortGraceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const missingPermissions: CheckGrokPermissions = async () => {
  throw new Error('Grok native permission policy is not configured');
};

/**
 * A machine momentarily out of processes, file handles or memory starts the CLI on
 * the next attempt; a missing binary or a denied path never does. Only the second
 * kind is answered as a request error.
 */
const TRANSIENT_SPAWN = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'ETXTBSY']);

function permanentFailure(error: GrokCliError): boolean {
  if (error.code === 'policy') {
    return true;
  }
  return error.code === 'spawn' && !TRANSIENT_SPAWN.has(error.systemCode ?? '');
}

export class GrokProviderError extends Error {
  readonly failure: { status: number; message: string };
  constructor(error: unknown) {
    // A busy agent, a policy the CLI did not apply, or a CLI that will not start,
    // fails the same way on every attempt. Reporting them as 502 had Claude retry a
    // paid run ten times over one prompt, so they are answered as a request error.
    const deterministic =
      error instanceof HarnessBusyError ||
      (error instanceof GrokCliError && permanentFailure(error));
    const detail = error && typeof error === 'object' && 'message' in error ? error.message : error;
    const reported = String(detail ?? 'unknown Grok failure');
    const advice = grokFailureAdvice(reported);
    const message = `${reported}${advice ? ` ${advice}` : ''}`
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    super(message, { cause: error });
    this.name = 'GrokProviderError';
    this.failure = { status: deterministic ? 400 : 502, message };
  }
}

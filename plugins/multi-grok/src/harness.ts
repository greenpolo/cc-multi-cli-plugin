import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  CliHarness,
  type CliTurn,
  digest,
  harnessFailure,
} from '../../multi-core/src/gateway/harness-cli.ts';
import { commitHarnessResponse } from '../../multi-core/src/gateway/harness-completion.ts';
import type { HarnessExchange } from '../../multi-core/src/gateway/harness-exchange.ts';
import {
  continuation,
  historyRewound,
  interruptedNotice,
  stderrDiagnostics,
  writeNotices,
} from '../../multi-core/src/gateway/harness-notices.ts';
import { NativeActionTracker } from '../../multi-core/src/gateway/harness-progress.ts';
import type { HarnessUsageFields } from '../../multi-core/src/gateway/harness-response.ts';
import {
  HarnessModelCalls,
  HarnessResponse,
} from '../../multi-core/src/gateway/harness-response.ts';
import type {
  HarnessSession,
  HarnessSessionBase,
} from '../../multi-core/src/gateway/harness-session.ts';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
} from '../../multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';
import { settleOrAbort } from '../../multi-core/src/gateway/settle.ts';
import type { GrokRunOptions, GrokRunResult, GrokStreamEvent, GrokUsage } from './cli.ts';
import { runGrok } from './cli.ts';
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

type GrokSelection = ReturnType<typeof selectGrokModel>;

export class GrokHarness extends CliHarness<GrokSaved, GrokSelection> {
  private readonly models: readonly GrokModel[];
  private readonly run: GrokRunner;
  private readonly checkPermissions: CheckGrokPermissions;

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
    super({
      tag: PROVIDER,
      storeProvider: STORE_PROVIDER,
      stateDirectory,
      defaultCwd: cwd,
      platform,
      version: 1,
      fresh: (identity) => ({ version: 1, provider: STORE_PROVIDER, identity, interrupted: false }),
      validate: (saved) =>
        (saved.sessionId === undefined || isUuid(saved.sessionId)) &&
        (saved.cost === undefined || (typeof saved.cost === 'number' && saved.cost >= 0)),
    });
    this.models = models;
    this.run = run;
    this.checkPermissions = checkPermissions ?? missingPermissions;
  }

  protected selection(body: MessagesRequest) {
    return selectGrokModel(this.models, body.model, body.output_config?.effort);
  }

  validate(body: MessagesRequest) {
    const selection = this.selection(body);
    return prepareGrokRequest(body, selection.model.id).inputTokens;
  }

  protected requestKey(body: MessagesRequest) {
    return {
      ...body,
      stream: undefined,
      messages: grokHistoryHash(body.messages),
      system: undefined,
    };
  }

  protected providerError(error: unknown) {
    return new GrokProviderError(error);
  }

  /**
   * Everything a turn needs before the CLI is invoked: the forwarded messages, the
   * checked policy, and a response primed with its opening notices. Split out of
   * `execute` to keep its own branching under the cognitive-complexity limit.
   */
  private async openTurn(
    turn: CliTurn<GrokSelection>,
    session: GrokSession,
    wasInterrupted: boolean,
    emit: Emit,
  ): Promise<{
    prepared: ReturnType<typeof prepareGrokRequest>;
    policy: GrokPolicy;
    response: HarnessResponse;
  }> {
    const { body, context, selection, cwd } = turn;
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
      body.safeguards,
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

  protected async execute(
    turn: CliTurn<GrokSelection>,
    session: GrokSession,
    exchange: HarnessExchange,
    emit: Emit,
  ): Promise<MessagesResponse> {
    const { selection, cwd, key, observe } = turn;
    const signal = exchange.controller.signal;
    const wasInterrupted = session.saved.interrupted;
    let started = false;
    try {
      const { prepared, policy, response } = await this.openTurn(
        turn,
        session,
        wasInterrupted,
        emit,
      );
      signal.throwIfAborted();
      const sessionId = session.saved.sessionId ?? randomUUID();
      let startSave: Promise<void> | undefined;
      // Each finished tool call becomes a display row in this reply, named after
      // Grok's own tool; the terse summary is written when the run settles.
      const actions = new NativeActionTracker(PROVIDER, observe, (block) =>
        response.displayRow(block),
      );
      const calls = new HarnessModelCalls();
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
        eventText(event, response, actions, calls);
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
      return await this.settle({
        session,
        response,
        outcome,
        selection,
        key,
        exchange,
        emit,
        actions,
        calls,
      });
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

  private async settle(run: {
    session: GrokSession;
    response: HarnessResponse;
    outcome: GrokRunResult;
    selection: GrokSelection;
    key: string;
    exchange: HarnessExchange;
    emit: Emit;
    actions: NativeActionTracker;
    calls: HarnessModelCalls;
  }): Promise<MessagesResponse> {
    const { session, response, outcome, selection, key, exchange, emit, actions, calls } = run;
    const result = outcome.result;
    // The CLI owns the identity it reports; a mismatch would silently fork history.
    if (session.saved.sessionId !== undefined && result.sessionId !== session.saved.sessionId) {
      throw new GrokProviderError(
        `Grok answered on session ${result.sessionId} instead of ${session.saved.sessionId}`,
      );
    }
    if (result.stopReason !== 'end_turn') {
      // Only end_turn is a finished answer. Cancelled, refused or truncated turns may have
      // run steps, so the next request resumes the session with the interruption notice.
      session.saved.sessionId = result.sessionId;
      session.saved.interrupted = true;
      session.saved.cost = (session.saved.cost ?? 0) + (result.costUsd ?? 0);
      await this.store.save(session);
      throw new GrokProviderError(`Grok stopped before finishing its turn (${result.stopReason})`);
    }
    response.text(actions.text(calls.count || result.turns));
    appendDiagnostics(response, outcome);
    const finished = response.finish(
      calls.turn(toHarnessUsage(result.usage), result.turns),
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
}

/**
 * Assistant text streams; native tool calls become display rows. Each model call
 * reports its own `usage` event before the `end` event sums them
 * (`test/unit/fixtures/grok/tool-denied-by-rule.jsonl`), so the last one is the context.
 */
function eventText(
  event: GrokStreamEvent,
  response: HarnessResponse,
  actions: NativeActionTracker,
  calls: HarnessModelCalls,
) {
  if (event.event === 'text') {
    response.text(event.text);
    return;
  }
  if (event.event === 'usage') {
    if (event.usage.input_tokens !== undefined) {
      calls.record({
        input: event.usage.input_tokens,
        output: event.usage.output_tokens,
        cacheRead: event.usage.cache_read_input_tokens,
        cacheCreate: event.usage.cache_creation_input_tokens,
      });
    }
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

/** Timing and cost reach the user through receipts; only warnings the model can act on stay. */
function appendDiagnostics(response: HarnessResponse, outcome: GrokRunResult) {
  const diagnostics = stderrDiagnostics(outcome.stderr);
  if (diagnostics) {
    response.text(`[Grok] ${diagnostics}\n`);
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
}

const missingPermissions: CheckGrokPermissions = async () => {
  throw new Error('Grok native permission policy is not configured');
};

export class GrokProviderError extends Error {
  readonly failure: { status: number; message: string };
  constructor(error: unknown) {
    // Deterministic failures are request errors; retrying them repeats a paid run.
    const failure = harnessFailure(error, 'unknown Grok failure', grokFailureAdvice);
    super(failure.message, { cause: error });
    this.name = 'GrokProviderError';
    this.failure = failure;
  }
}

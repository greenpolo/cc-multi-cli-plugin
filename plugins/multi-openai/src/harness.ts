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
import {
  type HarnessCallUsage,
  HarnessModelCalls,
  HarnessResponse,
  type HarnessUsageFields,
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
import {
  type CodexRunOptions,
  type CodexRunResult,
  type CodexStreamEvent,
  type CodexTokens,
  runCodexTurn,
} from './app-server.ts';
import { codexFailureAdvice, DETERMINISTIC_CODEX_ERRORS } from './errors.ts';
import { type CodexModel, type CodexSelection, selectCodexModel } from './models.ts';
import { type CodexPolicy, codexCompactionPolicy } from './permissions.ts';
import { observeCodexItem } from './progress.ts';
import { codexHistoryHash, prepareCodexRequest } from './request.ts';

export type CodexRunner = (options: CodexRunOptions) => Promise<CodexRunResult>;

export type CheckCodexPermissions = (
  cwd: string,
  context: PermissionContext,
) => Promise<CodexPolicy>;

/** Display tag used in notices and errors. */
const PROVIDER = 'Codex';
/** The persisted session discriminator; it is written to disk, so it stays as-is. */
const STORE_PROVIDER = 'codex';

type CodexSaved = HarnessSessionBase & {
  version: 1;
  /** Codex's own thread, which it keeps on disk under its home. */
  threadId?: string;
};
type CodexSession = HarnessSession<CodexSaved>;

/**
 * The tokens one turn consumed, from Codex's running thread totals: the total before
 * the turn's first call is that call's total less its own usage.
 */
class TurnTokens {
  private baseline: CodexTokens | undefined;
  private latest: CodexTokens | undefined;

  record(last: CodexTokens, total: CodexTokens) {
    this.baseline ??= subtract(total, last);
    this.latest = total;
  }

  consumed(): HarnessUsageFields | undefined {
    if (!this.baseline || !this.latest) {
      return undefined;
    }
    const used = subtract(this.latest, this.baseline);
    return {
      ...callUsage(used),
      reasoning: used.reasoningOutputTokens,
      total: used.totalTokens,
    };
  }
}

function subtract(left: CodexTokens, right: CodexTokens): CodexTokens {
  const minus = (key: keyof CodexTokens) => Math.max(0, left[key] - right[key]);
  return {
    totalTokens: minus('totalTokens'),
    inputTokens: minus('inputTokens'),
    cachedInputTokens: minus('cachedInputTokens'),
    outputTokens: minus('outputTokens'),
    reasoningOutputTokens: minus('reasoningOutputTokens'),
  };
}

/** Codex counts cached input inside `inputTokens`; Messages counts only the uncached part. */
function callUsage(tokens: CodexTokens): HarnessCallUsage {
  return {
    input: Math.max(0, tokens.inputTokens - tokens.cachedInputTokens),
    output: tokens.outputTokens,
    cacheRead: tokens.cachedInputTokens,
  };
}

/** Streams Codex's messages as text, one paragraph each, and its items as rows. */
class TurnOutput {
  private readonly streamed = new Set<string>();
  private wrote = false;
  private readonly response: HarnessResponse;
  private readonly actions: NativeActionTracker;
  private readonly calls: HarnessModelCalls;
  private readonly tokens: TurnTokens;

  constructor(
    response: HarnessResponse,
    actions: NativeActionTracker,
    calls: HarnessModelCalls,
    tokens: TurnTokens,
  ) {
    this.response = response;
    this.actions = actions;
    this.calls = calls;
    this.tokens = tokens;
  }

  private write(itemId: string, value: string) {
    if (!this.streamed.has(itemId)) {
      this.streamed.add(itemId);
      if (this.wrote) {
        this.response.text('\n\n');
      }
    }
    this.wrote = true;
    this.response.text(value);
  }

  observe(event: CodexStreamEvent) {
    if (event.event === 'text') {
      this.write(event.itemId, event.text);
    } else if (event.event === 'usage') {
      this.tokens.record(event.last, event.total);
      // Codex repeats an update when only its rate limits changed; the total identifies a call.
      this.calls.record(callUsage(event.last), String(event.total.totalTokens));
    } else if (event.event === 'item') {
      const { item } = event;
      if (
        event.phase === 'completed' &&
        item.type === 'agentMessage' &&
        !this.streamed.has(item.id) &&
        typeof item.text === 'string'
      ) {
        // A message that arrived whole, without deltas.
        this.write(item.id, item.text);
      }
      observeCodexItem(event.phase, item, this.actions);
    }
  }
}

export class CodexHarness extends CliHarness<CodexSaved, CodexSelection> {
  private readonly models: readonly CodexModel[];
  private readonly run: CodexRunner;
  private readonly checkPermissions: CheckCodexPermissions;

  constructor(
    models: readonly CodexModel[],
    {
      cwd = process.cwd(),
      stateDirectory = path.join(os.homedir(), '.codex', 'multi-harness'),
      run = runCodexTurn,
      checkPermissions,
      platform = process.platform,
    }: {
      cwd?: string;
      stateDirectory?: string;
      run?: CodexRunner;
      checkPermissions?: CheckCodexPermissions;
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
        saved.threadId === undefined ||
        (typeof saved.threadId === 'string' && /^[0-9a-f-]{36}$/.test(saved.threadId)),
    });
    this.models = models;
    this.run = run;
    this.checkPermissions = checkPermissions ?? missingPermissions;
  }

  protected selection(body: MessagesRequest) {
    return selectCodexModel(this.models, body.model, body.output_config?.effort);
  }

  validate(body: MessagesRequest) {
    this.selection(body);
    return prepareCodexRequest(body).inputTokens;
  }

  protected requestKey(body: MessagesRequest) {
    return {
      ...body,
      stream: undefined,
      messages: codexHistoryHash(body.messages),
      system: undefined,
    };
  }

  protected providerError(error: unknown) {
    return new CodexProviderError(error);
  }

  /** The prompt, the checked policy, and a response primed with its opening notices. */
  private async openTurn(
    turn: CliTurn<CodexSelection>,
    session: CodexSession,
    wasInterrupted: boolean,
    emit: Emit,
  ) {
    const { body, context, selection, cwd } = turn;
    // Codex keeps the thread, so a continued one only hears what is new since its last answer.
    const messages = session.saved.threadId ? continuation(body, PROVIDER) : (body.messages ?? []);
    const rewound = historyRewound(session.saved, body.messages ?? [], codexHistoryHash);
    const prepared = prepareCodexRequest({ ...body, messages });
    // A run policy is always checked first, so a broken setting fails before Codex starts.
    const checked = await this.checkPermissions(cwd, context);
    const policy = context.compaction === undefined ? checked : codexCompactionPolicy();
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

  protected async execute(
    turn: CliTurn<CodexSelection>,
    session: CodexSession,
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
      let startSave: Promise<void> | undefined;
      const actions = new NativeActionTracker(PROVIDER, observe, (block) =>
        response.displayRow(block),
      );
      const calls = new HarnessModelCalls();
      const tokens = new TurnTokens();
      const output = new TurnOutput(response, actions, calls, tokens);
      const onEvent = (event: CodexStreamEvent) => {
        if (event.event === 'thread') {
          // The thread exists before the turn runs. Recording it now means a crash resumes
          // this conversation instead of starting a fresh one.
          started = true;
          session.saved.threadId = event.threadId;
          session.saved.interrupted = true;
          startSave = this.store.save(session).catch(() => {
            // The run continues regardless of a failed durability write.
          });
          return;
        }
        output.observe(event);
      };
      const outcome = await settleOrAbort(
        this.run({
          cwd,
          prompt: wasInterrupted
            ? `${interruptedNotice(PROVIDER)}\n\n${prepared.prompt}`
            : prepared.prompt,
          model: selection.model.id,
          ...(selection.effort ? { effort: selection.effort } : {}),
          ...(session.saved.threadId ? { resume: session.saved.threadId } : {}),
          sandbox: policy.sandbox,
          config: policy.config,
          ...(policy.mcpOff ? { mcpOff: policy.mcpOff } : {}),
          signal,
          onEvent,
        }),
        signal,
        'Codex native run',
      );
      await startSave;
      return await this.settle({
        session,
        response,
        outcome,
        selection,
        key,
        exchange,
        actions,
        calls,
        tokens,
      });
    } catch (error) {
      if (error instanceof CodexProviderError) {
        throw error;
      }
      // The turn ended without an outcome after Codex began it, so the next request
      // resumes the thread and says so.
      if (started) {
        session.saved.interrupted = true;
        await this.store.save(session).catch(() => {
          // The run failure below is the more useful error to surface.
        });
      }
      throw new CodexProviderError(error);
    }
  }

  private async settle(run: {
    session: CodexSession;
    response: HarnessResponse;
    outcome: CodexRunResult;
    selection: CodexSelection;
    key: string;
    exchange: HarnessExchange;
    actions: NativeActionTracker;
    calls: HarnessModelCalls;
    tokens: TurnTokens;
  }): Promise<MessagesResponse> {
    const { session, response, outcome, selection, key, exchange, actions, calls, tokens } = run;
    const result = outcome.result;
    if (result.status !== 'completed') {
      // Only a completed turn is a finished answer. An interrupted or failed one may have
      // run steps, so the next request resumes the thread with the interruption notice.
      session.saved.threadId = result.threadId;
      session.saved.interrupted = true;
      await this.store.save(session);
      throw new CodexProviderError(
        new CodexTurnError(
          result.error?.message ?? `Codex stopped before finishing its turn (${result.status})`,
          result.error?.info,
        ),
      );
    }
    response.text(actions.text(calls.count || undefined));
    const diagnostics = stderrDiagnostics(outcome.stderr);
    if (diagnostics) {
      response.text(`[${PROVIDER}] ${diagnostics}\n`);
    }
    const finished = response.finish(
      calls.turn(tokens.consumed()),
      selection.model.id,
      selection.effort,
    );
    return commitHarnessResponse({
      session,
      store: this.store,
      finished,
      exchange,
      key,
      update: (saved) => {
        saved.threadId = result.threadId;
        saved.interrupted = false;
      },
    });
  }
}

const missingPermissions: CheckCodexPermissions = async () => {
  throw new Error('Codex native permission policy is not configured');
};

/** A turn Codex itself failed, with its error kind (`usageLimitExceeded`, say). */
class CodexTurnError extends Error {
  readonly info: string | undefined;
  constructor(message: string, info?: string) {
    super(message);
    this.name = 'CodexTurnError';
    this.info = info;
  }
}

class CodexProviderError extends Error {
  readonly failure: { status: number; message: string };
  constructor(error: unknown) {
    const failure = harnessFailure(error, 'unknown Codex failure', codexFailureAdvice);
    super(failure.message, { cause: error });
    this.name = 'CodexProviderError';
    // A spent plan window or a refused request fails the same way until something changes:
    // a request error, so Claude Code shows Codex's words instead of retrying a paid run.
    const deterministic =
      error instanceof CodexTurnError && DETERMINISTIC_CODEX_ERRORS.has(error.info ?? '');
    this.failure = deterministic ? { ...failure, status: 400 } : failure;
  }
}

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
  safeText,
  stderrDiagnostics,
  terminalSuffix,
  writeNotices,
} from '../../multi-core/src/gateway/harness-notices.ts';
import { NativeActionTracker } from '../../multi-core/src/gateway/harness-progress.ts';
import {
  HarnessModelCalls,
  HarnessResponse,
  type HarnessUsageFields,
} from '../../multi-core/src/gateway/harness-response.ts';
import {
  type HarnessSession,
  type HarnessSessionBase,
  isRecord,
} from '../../multi-core/src/gateway/harness-session.ts';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
} from '../../multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';
import { settleOrAbort } from '../../multi-core/src/gateway/settle.ts';
import type {
  AntigravityResult,
  AntigravityRunOptions,
  AntigravityRunResult,
  AntigravityStreamEvent,
  AntigravityUsage,
} from './cli.ts';
import { runAntigravity } from './cli.ts';
import { antigravitySettingsFile } from './hooks.ts';
import type { AntigravityModel } from './models.ts';
import { nativeSpelling, selectAntigravityModel } from './models.ts';
import { type AntigravityPolicy, antigravityCompactionDenyList } from './permissions.ts';
import {
  observeAntigravityCall,
  observeAntigravityInit,
  observeAntigravityStep,
} from './progress.ts';
import { antigravityHistoryHash, prepareAntigravityRequest } from './request.ts';

export type AntigravityRunner = (options: AntigravityRunOptions) => Promise<AntigravityRunResult>;

export type CheckAntigravityPermissions = (
  cwd: string,
  context: PermissionContext,
) => Promise<AntigravityPolicy>;

const PROVIDER = 'antigravity';
const TAG = 'Antigravity';
const SESSION_VERSION = 2;

type Saved = HarnessSessionBase & {
  version: typeof SESSION_VERSION;
  conversationId?: string;
  usage?: AntigravityUsage;
};
type Session = HarnessSession<Saved>;

function modelEffort(model: AntigravityModel): AntigravityRunOptions['effort'] {
  if (model.effort) {
    return model.effort;
  }
  const suffix = model.id.split('-').at(-1);
  return suffix === 'low' || suffix === 'medium' || suffix === 'high' ? suffix : undefined;
}

function deniedForRun(policy: AntigravityPolicy, context: PermissionContext) {
  return context.compaction === undefined ? policy.denied : antigravityCompactionDenyList();
}

function nativeEnvironment(denied: string[], allowed: string[] | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env, MULTI_ANTIGRAVITY_DENY: JSON.stringify(denied) };
  delete env.MULTI_ANTIGRAVITY_ALLOW;
  if (allowed) {
    env.MULTI_ANTIGRAVITY_ALLOW = JSON.stringify(allowed);
  }
  return env;
}

/** A compaction turn is tool-free: nothing is allowed, whatever the catalog adds. */
function allowedForRun(policy: AntigravityPolicy, context: PermissionContext) {
  return context.compaction === undefined ? policy.allowed : [];
}

function noticeForRun(policy: AntigravityPolicy, context: PermissionContext) {
  return context.compaction === undefined
    ? policy.notice
    : 'Compaction summary; native tools disabled.';
}

export class AntigravityHarness extends CliHarness<Saved, AntigravityModel> {
  private readonly models: readonly AntigravityModel[];
  private readonly run: AntigravityRunner;
  private readonly checkPermissions: CheckAntigravityPermissions;
  private unindexedSteps = 0;

  constructor(
    models: readonly AntigravityModel[],
    {
      cwd = process.cwd(),
      stateDirectory = path.join(
        path.dirname(antigravitySettingsFile({ homedir: os.homedir() })),
        'multi-harness',
      ),
      run = runAntigravity,
      checkPermissions,
      platform = process.platform,
    }: {
      cwd?: string;
      stateDirectory?: string;
      run?: AntigravityRunner;
      checkPermissions?: CheckAntigravityPermissions;
      platform?: NodeJS.Platform;
    } = {},
  ) {
    super({
      tag: TAG,
      storeProvider: PROVIDER,
      stateDirectory,
      defaultCwd: cwd,
      platform,
      version: SESSION_VERSION,
      fresh: (identity) => ({
        version: SESSION_VERSION,
        provider: PROVIDER,
        identity,
        interrupted: false,
      }),
      validate: (saved) => validUsage(saved.usage),
    });
    this.models = models;
    this.run = run;
    this.checkPermissions = checkPermissions ?? missingPermissions;
  }

  protected selection(body: MessagesRequest) {
    return selectAntigravityModel(this.models, body.model, body.output_config?.effort);
  }

  validate(body: MessagesRequest) {
    const model = this.selection(body);
    return prepareAntigravityRequest(body, model.id).inputTokens;
  }

  protected requestKey(body: MessagesRequest) {
    return {
      ...body,
      // Both spellings of a model name the same native request. Keying on the tagged one
      // would let the plain spelling miss a completed exchange and dispatch it a second
      // time, which is exactly what happens across a MULTI_DISABLE_1M_CONTEXT change.
      model: nativeSpelling(body.model),
      stream: undefined,
      messages: antigravityHistoryHash(body.messages),
      system: undefined,
    };
  }

  protected providerError(error: unknown) {
    return new AntigravityProviderError(error);
  }

  protected async execute(
    turn: CliTurn<AntigravityModel>,
    session: Session,
    exchange: HarnessExchange,
    emit: Emit,
  ): Promise<MessagesResponse> {
    try {
      // Inside the try: a busy agent must be refused with this provider's own
      // failure, whose status is deterministic rather than retryable. The turn is
      // owned from here on, so every exit below releases it.
      const messages = session.saved.conversationId
        ? continuation(turn.body, TAG)
        : (turn.body.messages ?? []);
      const rewound = historyRewound(
        session.saved,
        turn.body.messages ?? [],
        antigravityHistoryHash,
      );
      return await this.runTurn(turn, { session, messages, rewound }, exchange, emit);
    } catch (error) {
      if (error instanceof AntigravityProviderError) {
        throw error;
      }
      throw new AntigravityProviderError(error);
    }
  }

  private async runTurn(
    turn: CliTurn<AntigravityModel>,
    acquired: { session: Session; messages: MessagesRequest['messages']; rewound: boolean },
    exchange: HarnessExchange,
    emit: Emit,
  ): Promise<MessagesResponse> {
    const { body, context, cwd, key } = turn;
    const model = turn.selection;
    const { session, messages, rewound } = acquired;
    const signal = exchange.controller.signal;
    let initConversationId: string | undefined;
    try {
      const prepared = prepareAntigravityRequest({ ...body, messages }, model.id);
      if (session.saved.interrupted) {
        prepared.prompt = `${interruptedNotice(TAG)}\n\n${prepared.prompt}`;
      }
      const policy = await this.checkPermissions(cwd, context);
      const nativeDenied = deniedForRun(policy, context);
      const nativeAllowed = allowedForRun(policy, context);
      const notice = noticeForRun(policy, context);
      const response = new HarnessResponse(
        body.model ?? model.model,
        prepared.inputTokens,
        emit,
        body.safeguards,
      );
      const policyIdentity = digest({
        denied: nativeDenied,
        allowed: nativeAllowed ?? null,
        plan: policy.plan,
        notice,
      });
      writeNotices(response, {
        tag: TAG,
        interrupted: session.saved.interrupted,
        rewound,
        notice,
        noticeChanged: !session.saved.response || session.saved.policyIdentity !== policyIdentity,
      });
      session.saved.policyIdentity = policyIdentity;
      signal.throwIfAborted();
      let streamed = '';
      let initSave: Promise<void> | undefined;
      // Each finished tool step becomes a display row in this reply, named after
      // agy's own tool; the terse summary is written when the run commits.
      const actions = new NativeActionTracker(TAG, turn.observe, (block) =>
        response.displayRow(block),
      );
      const calls = new HarnessModelCalls();
      const outcome = await settleOrAbort(
        this.run({
          cwd,
          prompt: prepared.prompt,
          model: model.id,
          effort: modelEffort(model),
          ...(session.saved.conversationId ? { conversation: session.saved.conversationId } : {}),
          ...(policy.plan ? { mode: 'plan' as const } : {}),
          env: nativeEnvironment(nativeDenied, nativeAllowed),
          signal,
          onEvent: (event) =>
            this.eventText(
              event,
              response,
              { actions, calls },
              (text) => {
                streamed += text;
              },
              (conversationId) => {
                session.saved.conversationId = conversationId;
                session.saved.interrupted = true;
                initConversationId = conversationId;
                // Best-effort durability write: if the gateway crashes before a
                // terminal result arrives, the next request resumes this native
                // conversation with the interrupted notice instead of starting a
                // fresh one. Fired here, not awaited here, so it never blocks the
                // stream; awaited below before the terminal result is processed.
                initSave = this.store.save(session).catch(() => {
                  // The run continues regardless of a failed durability write.
                });
              },
            ),
        }),
        signal,
        'Antigravity native run',
      );
      await initSave;
      const result = outcome.result;
      appendDiagnostics(response, result, outcome.stderr);
      if (result.status !== 'SUCCESS') {
        session.saved.conversationId = result.conversation_id;
        // A failed run may still have executed steps. Keep the interruption flag so a retry
        // tells the native conversation what may already have happened.
        session.saved.interrupted =
          initConversationId !== undefined || streamed.length > 0 || calls.count > 0;
        await this.store.save(session);
        throw new AntigravityProviderError(result.error ?? `Antigravity run ${result.status}`);
      }
      return await this.commit(
        session,
        response,
        result,
        exchange,
        key,
        model,
        { streamed, summary: actions.text(calls.count), calls },
        emit,
      );
    } catch (error) {
      // The run ended without a terminal result (abort, kill, or a CLI/parse
      // failure). If agy ever reported a conversation id for this attempt, the
      // native turn's completion is unknown; flag it so the next request can
      // ask agy to report its own state instead of guessing.
      if (!(error instanceof AntigravityProviderError) && initConversationId !== undefined) {
        session.saved.interrupted = true;
        await this.store.save(session).catch(() => {
          // The run failure below is the more useful error to surface.
        });
      }
      throw error;
    }
  }

  /** The turn is durable before its terminal events reach the caller. */
  private async commit(
    session: Session,
    response: HarnessResponse,
    result: AntigravityResult,
    exchange: HarnessExchange,
    key: string,
    model: AntigravityModel,
    text: { streamed: string; summary: string; calls: HarnessModelCalls },
    emit: Emit,
  ): Promise<MessagesResponse> {
    response.text(terminalSuffix(text.streamed, result.response));
    response.text(text.summary);
    // Only the turn's consumption is cumulative across a resumed conversation;
    // the last call's context is that call's own count and never goes through the delta.
    const finished = response.finish(
      text.calls.turn(usageFields(usageDelta(result.usage, session.saved.usage))),
      model.id,
      modelEffort(model),
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
        saved.conversationId = result.conversation_id;
        saved.interrupted = false;
        saved.usage = result.usage;
      },
    });
  }

  private eventText(
    event: AntigravityStreamEvent,
    response: HarnessResponse,
    observers: { actions: NativeActionTracker; calls: HarnessModelCalls },
    add: (text: string) => void,
    init: (conversationId: string) => void,
  ) {
    const { actions, calls } = observers;
    if (event.event === 'init') {
      init(event.conversation_id);
      observeAntigravityInit(event.init, actions);
      return;
    }
    if (event.event !== 'step_update') {
      return;
    }
    const update = event.step_update;
    // A call's usage arrives on the same update as its last text, so it is read first.
    observeAntigravityCall(update, calls);
    if (typeof update.text_delta === 'string') {
      add(update.text_delta);
      response.text(update.text_delta);
      return;
    }
    observeAntigravityStep(update, actions, () => `tool-${++this.unindexedSteps}`);
  }
}

function appendDiagnostics(response: HarnessResponse, result: AntigravityResult, stderr: string) {
  const denied = result.denied_actions;
  if (Array.isArray(denied) && denied.length) {
    const detail = denied
      .map((action) => {
        if (isRecord(action)) {
          return [action.display_name, action.action, action.reason]
            .filter((item) => typeof item === 'string')
            .join(':');
        }
        return String(action);
      })
      .join(', ');
    response.text(`[${TAG}] denied actions: ${safeText(detail)}\n`);
  }
  const diagnostics = stderrDiagnostics(stderr);
  if (diagnostics) {
    response.text(`[${TAG}] ${diagnostics}\n`);
  }
}

/** agy counts a resumed conversation cumulatively; a turn reports only its own share. */
function usageDelta(current: AntigravityUsage | undefined, previous: AntigravityUsage | undefined) {
  if (!current || !previous) {
    return current;
  }
  const delta: AntigravityUsage = {};
  for (const key of [
    'input_tokens',
    'output_tokens',
    'thinking_tokens',
    'cache_read_tokens',
    'total_tokens',
  ] as const) {
    const value = current[key];
    const old = previous[key];
    if (value !== undefined) {
      delta[key] = old !== undefined && value >= old ? value - old : value;
    }
  }
  return delta;
}

/** agy's usage vocabulary, mapped onto the shared one. */
function usageFields(usage: AntigravityUsage | undefined): HarnessUsageFields | undefined {
  if (usage === undefined) {
    return undefined;
  }
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_tokens,
    reasoning: usage.thinking_tokens,
    total: usage.total_tokens,
  };
}

function validUsage(usage: AntigravityUsage | undefined) {
  return (
    usage === undefined ||
    (isRecord(usage) &&
      Object.values(usage).every(
        (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
      ))
  );
}

const missingPermissions: CheckAntigravityPermissions = async () => {
  throw new Error('Antigravity native permission policy is not configured');
};

export class AntigravityProviderError extends Error {
  readonly failure: { status: number; message: string };
  constructor(error: unknown) {
    // Deterministic refusals are request errors: a retryable status turned one
    // into ten paid attempts.
    const failure = harnessFailure(error, 'unknown Antigravity failure');
    super(failure.message, { cause: error });
    this.name = 'AntigravityProviderError';
    this.failure = failure;
  }
}

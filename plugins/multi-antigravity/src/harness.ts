import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ExchangeRegistry,
  type HarnessEvent,
  type HarnessExchange,
  replayPersisted,
} from '../../multi-core/src/gateway/harness-exchange.ts';
import {
  continuation,
  historyRewound,
  interruptedNotice,
  safeText,
  stderrDiagnostics,
  terminalSuffix,
  writeNotices,
} from '../../multi-core/src/gateway/harness-notices.ts';
import {
  HarnessResponse,
  type HarnessUsageFields,
} from '../../multi-core/src/gateway/harness-response.ts';
import {
  atomicJson,
  HarnessBusyError,
  type HarnessSessionBase,
  type HarnessSessionRuntime,
  HarnessSessionStore,
  isRecord,
} from '../../multi-core/src/gateway/harness-session.ts';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
} from '../../multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';
import { abortGraceMs, settleOrAbort } from '../../multi-core/src/gateway/settle.ts';
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
type Session = Saved & HarnessSessionRuntime;

/** Everything one native turn is addressed by, fixed before the exchange starts. */
type Turn = {
  body: MessagesRequest;
  context: PermissionContext;
  model: AntigravityModel;
  cwd: string;
  identity: string;
  key: string;
};

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

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

function noticeForRun(policy: AntigravityPolicy, context: PermissionContext) {
  return context.compaction === undefined
    ? policy.notice
    : 'Compaction summary; native tools disabled.';
}

export class AntigravityHarness {
  private readonly models: readonly AntigravityModel[];
  private readonly defaultCwd: string;
  private readonly stateDirectory: string;
  private readonly run: AntigravityRunner;
  private readonly checkPermissions: CheckAntigravityPermissions;
  private readonly platform: NodeJS.Platform;
  private readonly store: HarnessSessionStore<Saved>;
  private readonly exchanges = new ExchangeRegistry({ provider: TAG });
  private closed = false;

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
    this.models = models;
    this.defaultCwd = cwd;
    this.stateDirectory = stateDirectory;
    this.platform = platform;
    this.run = run;
    this.checkPermissions = checkPermissions ?? missingPermissions;
    this.store = new HarnessSessionStore<Saved>({
      provider: PROVIDER,
      tag: TAG,
      stateDirectory,
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
  }

  private selection(body: MessagesRequest) {
    return selectAntigravityModel(this.models, body.model, body.output_config?.effort);
  }

  validate(body: MessagesRequest) {
    const model = this.selection(body);
    return prepareAntigravityRequest(body, model.id).inputTokens;
  }

  async handle(
    body: MessagesRequest,
    scope: string,
    signal: AbortSignal,
    emit?: Emit,
    context?: PermissionContext,
  ): Promise<MessagesResponse> {
    if (this.closed) {
      throw new Error('Antigravity harness is closed');
    }
    signal.throwIfAborted();
    if (!context) {
      throw new Error('Antigravity requires an explicit Claude permission context');
    }
    const model = this.selection(body);
    this.validate(body);
    const cwd = await realpath(context.cwd ?? this.defaultCwd);
    const identity = `${cwd}\0${scope}`;
    const key = digest([
      PROVIDER,
      identity,
      {
        ...body,
        // Both spellings of a model name the same native request. Keying on the tagged one
        // would let the plain spelling miss a completed exchange and dispatch it a second
        // time, which is exactly what happens across a MULTI_DISABLE_1M_CONTEXT change.
        model: nativeSpelling(body.model),
        stream: undefined,
        messages: antigravityHistoryHash(body.messages),
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
    const turn: Turn = { body, context, model, cwd, identity, key };
    let exchange = this.exchanges.get(key);
    if (!exchange) {
      if (this.exchanges.size >= 256) {
        throw new Error('Too many concurrent Antigravity requests');
      }
      exchange = this.exchanges.start(key, (started, forward) =>
        this.cachedExecute(turn, started, forward),
      );
    }
    return this.exchanges.observe(exchange, signal, emit);
  }

  private async cachedExecute(turn: Turn, exchange: HarnessExchange, emit: Emit) {
    let saved: Session;
    try {
      // A first-load race is a deterministic conflict, so it must leave here as
      // this provider's own failure: a bare busy error reads as a retryable 502.
      saved = await this.store.loadOnly(turn.identity);
    } catch (error) {
      throw new AntigravityProviderError(error);
    }
    const replayed = await replayPersisted({
      stateDirectory: this.stateDirectory,
      key: turn.key,
      saved,
      emit,
      provider: TAG,
    });
    return replayed ?? this.execute(turn, exchange, emit);
  }

  private async execute(
    turn: Turn,
    exchange: HarnessExchange,
    emit: Emit,
  ): Promise<MessagesResponse> {
    let session: Session | undefined;
    try {
      // Inside the try: a busy agent must be refused with this provider's own
      // failure, whose status is deterministic rather than retryable. The turn is
      // owned from here on, so every exit below releases it.
      session = await this.store.acquire(turn.identity);
      const messages = session.conversationId
        ? continuation(turn.body, TAG)
        : (turn.body.messages ?? []);
      const rewound = historyRewound(session, turn.body.messages ?? [], antigravityHistoryHash);
      return await this.runTurn(turn, { session, messages, rewound }, exchange, emit);
    } catch (error) {
      if (error instanceof AntigravityProviderError) {
        throw error;
      }
      throw new AntigravityProviderError(error);
    } finally {
      if (session) {
        this.store.release(session);
        if (this.closed) {
          await this.store.releaseLock(session);
        }
      }
    }
  }

  private async runTurn(
    turn: Turn,
    acquired: { session: Session; messages: MessagesRequest['messages']; rewound: boolean },
    exchange: HarnessExchange,
    emit: Emit,
  ): Promise<MessagesResponse> {
    const { body, context, model, cwd, key } = turn;
    const { session, messages, rewound } = acquired;
    const signal = exchange.controller.signal;
    let initConversationId: string | undefined;
    try {
      const prepared = prepareAntigravityRequest({ ...body, messages }, model.id);
      if (session.interrupted) {
        prepared.prompt = `${interruptedNotice(TAG)}\n\n${prepared.prompt}`;
      }
      const policy = await this.checkPermissions(cwd, context);
      const nativeDenied = deniedForRun(policy, context);
      const notice = noticeForRun(policy, context);
      const response = new HarnessResponse(body.model ?? model.model, prepared.inputTokens, emit);
      const policyIdentity = digest({ denied: nativeDenied, plan: policy.plan, notice });
      writeNotices(response, {
        tag: TAG,
        interrupted: session.interrupted,
        rewound,
        notice,
        noticeChanged: !session.response || session.policyIdentity !== policyIdentity,
      });
      session.policyIdentity = policyIdentity;
      signal.throwIfAborted();
      let streamed = '';
      let initSave: Promise<void> | undefined;
      const startedAt = performance.now();
      const outcome = await settleOrAbort(
        this.run({
          cwd,
          prompt: prepared.prompt,
          model: model.id,
          effort: modelEffort(model),
          ...(session.conversationId ? { conversation: session.conversationId } : {}),
          ...(policy.plan ? { mode: 'plan' as const } : {}),
          env: { ...process.env, MULTI_ANTIGRAVITY_DENY: JSON.stringify(nativeDenied) },
          signal,
          onEvent: (event) =>
            this.eventText(
              event,
              response,
              (text) => {
                streamed += text;
              },
              (conversationId) => {
                session.conversationId = conversationId;
                session.interrupted = true;
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
      session.conversationId = result.conversation_id;
      session.interrupted = false;
      appendDiagnostics(response, result, outcome.stderr, performance.now() - startedAt);
      if (result.status !== 'SUCCESS') {
        await this.store.save(session);
        throw new AntigravityProviderError(result.error ?? `Antigravity run ${result.status}`);
      }
      return await this.commit(session, response, result, exchange, key, model, streamed, emit);
    } catch (error) {
      // The run ended without a terminal result (abort, kill, or a CLI/parse
      // failure). If agy ever reported a conversation id for this attempt, the
      // native turn's completion is unknown; flag it so the next request can
      // ask agy to report its own state instead of guessing.
      if (!(error instanceof AntigravityProviderError) && initConversationId !== undefined) {
        session.interrupted = true;
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
    streamed: string,
    emit: Emit,
  ): Promise<MessagesResponse> {
    response.text(terminalSuffix(streamed, result.response));
    const finished = response.finish(
      usageFields(usageDelta(result.usage, session.usage)),
      model.id,
      modelEffort(model),
    );
    const terminalEvents = response.takeTerminalEvents();
    session.usage = result.usage;
    session.response = finished;
    session.replay = {
      key,
      events: [
        ...exchange.events,
        ...terminalEvents.map(([name, value]) => [name, structuredClone(value)] as HarnessEvent),
      ],
    };
    await this.store.save(session);
    await atomicJson(
      path.join(this.stateDirectory, `${key}.response.json`),
      { response: finished, events: session.replay.events },
      this.platform,
    );
    for (const event of terminalEvents) {
      emit(...event);
    }
    return finished;
  }

  private eventText(
    event: AntigravityStreamEvent,
    response: HarnessResponse,
    add: (text: string) => void,
    init: (conversationId: string) => void,
  ) {
    if (event.event === 'init') {
      init(event.conversation_id);
      return;
    }
    if (event.event !== 'step_update') {
      return;
    }
    const update = event.step_update;
    if (typeof update.text_delta === 'string') {
      add(update.text_delta);
      response.text(update.text_delta);
    } else if (typeof update.tool_name === 'string') {
      const detail = [
        update.step_type,
        update.duration_seconds !== undefined ? `${update.duration_seconds}s` : undefined,
        update.tool_info ? safeText(JSON.stringify(update.tool_info)) : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
      response.text(`\n[${TAG}] ${update.tool_name}${detail ? ` (${detail})` : ''}\n`);
    }
  }

  async close() {
    this.closed = true;
    const running: Promise<MessagesResponse>[] = [];
    for (const exchange of this.exchanges.all()) {
      if (!exchange.settled) {
        exchange.controller.abort(new Error('Antigravity gateway closed'));
        running.push(exchange.result);
      }
    }
    await bounded(Promise.allSettled(running));
    await this.store.closeAll();
  }
}

function appendDiagnostics(
  response: HarnessResponse,
  result: AntigravityResult,
  stderr: string,
  elapsedMs: number,
) {
  if (Number.isFinite(elapsedMs)) {
    response.text(`[${TAG}] completed in ${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s\n`);
  }
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

const missingPermissions: CheckAntigravityPermissions = async () => {
  throw new Error('Antigravity native permission policy is not configured');
};

export class AntigravityProviderError extends Error {
  readonly failure: { status: number; message: string };
  constructor(error: unknown) {
    const detail = error && typeof error === 'object' && 'message' in error ? error.message : error;
    const message = String(detail ?? 'unknown Antigravity failure')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    super(message, { cause: error });
    this.name = 'AntigravityProviderError';
    // A busy agent is a deterministic conflict, not a transient fault: a
    // retryable status turned one such refusal into ten paid attempts.
    this.failure = { status: error instanceof HarnessBusyError ? 400 : 502, message };
  }
}

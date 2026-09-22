import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentOptions, AgentUsage, Run, SDKAgent, TokenUsage } from '@cursor/sdk';
import type { WorkerPermissions } from '../../multi-core/src/gateway/agent-definitions.ts';
import {
  archiveHarnessReply,
  commitHarnessResponse,
} from '../../multi-core/src/gateway/harness-completion.ts';
import {
  ExchangeRegistry,
  type HarnessEvent,
  type HarnessExchange,
  replayPersisted,
} from '../../multi-core/src/gateway/harness-exchange.ts';
import {
  continuation,
  harnessHistoryHash,
  historyRewound,
  interruptedNotice,
  terminalSuffix,
  writeNotices,
} from '../../multi-core/src/gateway/harness-notices.ts';
import {
  HarnessResponse,
  type HarnessUsageFields,
} from '../../multi-core/src/gateway/harness-response.ts';
import {
  type ContentBlockCheck,
  HarnessBusyError,
  type HarnessSession,
  type HarnessSessionBase,
  HarnessSessionStore,
  type HarnessTurnLease,
  isHash,
  isRecord,
  readJson,
  textContentBlock,
} from '../../multi-core/src/gateway/harness-session.ts';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
} from '../../multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';
import { settleOrAbort } from '../../multi-core/src/gateway/settle.ts';
import { CursorProviderError, cursorRunError } from './errors.ts';
import { type CursorModelOption, cursorSelection } from './models.ts';
import {
  cursorNativePermissions,
  cursorPermissionPolicy,
  mergeCursorPermissions,
} from './permissions.ts';
import type { NativeRowObserver } from './progress.ts';
import { cursorRowObservation, formatCursorProgress } from './progress.ts';
import { prepareCursorRequest } from './request.ts';
import { legacyCursorSessionFile, restoreCursorSession } from './session-record.ts';

type Agent = Pick<SDKAgent, 'agentId' | 'send' | 'close'> & Partial<Pick<SDKAgent, 'getUsage'>>;
export type CreateCursorHarnessAgent = (options: AgentOptions) => Promise<Agent>;
type PendingRun = {
  key: string;
  runId?: string;
  model: string;
  effort?: string;
  inputTokens: number;
};
/**
 * The persisted half. Version 3 carries the shared `provider`/`identity` header.
 * Version 2 records are migrated while holding both generations' lock files.
 */
type SavedSession = HarnessSessionBase & {
  version: 3;
  agentId?: string;
  pendingRun?: PendingRun;
};
/** SDK handles and reservations never enter the persisted session record. */
type CursorRuntime = {
  agent?: Agent;
  run?: Run;
  policy?: string;
};
type Session = HarnessSession<SavedSession, CursorRuntime>;
type ReadySession = Session & { runtime: CursorRuntime & { agent: Agent } };
type TurnLease = HarnessTurnLease<SavedSession, CursorRuntime>;
/** Run facts the exchange carries for us; the registry never reads them. */
type RunState = {
  mayHaveRun?: boolean;
  committed?: boolean;
  succeeded?: boolean;
};

const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');
type CursorExchange = HarnessExchange<RunState>;

/**
 * Cursor is the one harness whose reply is not text alone: a mod display row is
 * persisted as a `tool_use` block, so a replay that rejected it would fail the
 * turn forever. The block is display-only and is never executed as a tool.
 */
const cursorContentBlock: ContentBlockCheck = (block) =>
  textContentBlock(block) ||
  (block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    typeof block.name === 'string' &&
    isRecord(block.input));

const billedUsageTimeoutMs = 5000;
const maximumAgents = 32;
const maximumExchanges = 256;

function selectedEffort(selection: ReturnType<CursorHarness['selection']>) {
  return selection.params?.find(
    (parameter) => parameter.id === 'effort' || parameter.id === 'reasoning_effort',
  )?.value;
}

/** Cursor's own usage vocabulary, mapped once into the shared one. */
function cursorUsage(usage: TokenUsage | undefined): HarnessUsageFields | undefined {
  return usage
    ? {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheCreate: usage.cacheWriteTokens,
        reasoning: usage.reasoningTokens,
        total: usage.totalTokens,
      }
    : undefined;
}

async function boundedUsage(request: Promise<AgentUsage>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<AgentUsage>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Cursor billed usage request timed out')),
          billedUsageTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cursor owns state, tools and review. External actions are display-only text. */
export class CursorHarness {
  private readonly options: Map<string, CursorModelOption>;
  private readonly store: HarnessSessionStore<SavedSession, CursorRuntime>;
  private readonly registry = new ExchangeRegistry<RunState>({
    provider: 'Cursor',
    createMeta: () => ({}),
  });
  private cwd: string;
  private readonly stateDirectory: string;
  private readonly platform: NodeJS.Platform;
  private readonly resumeAgent: (id: string, options: AgentOptions) => Promise<Agent>;
  private readonly createAgent: CreateCursorHarnessAgent;
  private readonly checkPermissions: () => Promise<WorkerPermissions>;
  private readonly getRun: (id: string, cwd: string) => Promise<Run>;
  private closed = false;
  private readonly closedAgents = new WeakSet<Agent>();
  private readonly attaching = new Set<Session>();
  private readonly usageReaders = new Map<Agent, number>();

  constructor(
    options: CursorModelOption[],
    {
      cwd = process.cwd(),
      checkPermissions = async () => ({}),
      stateDirectory,
      platform = process.platform,
      env = process.env,
      home = homedir(),
      resumeAgent = async (id: string, config: AgentOptions) =>
        (await import('@cursor/sdk')).Agent.resume(id, config),
      getRun = async (id: string, cwd: string) =>
        (await import('@cursor/sdk')).Agent.getRun(id, { cwd, runtime: 'local' }),
      createAgent = async (config: AgentOptions) =>
        (await import('@cursor/sdk')).Agent.create(config),
    }: {
      cwd?: string;
      checkPermissions?: () => Promise<WorkerPermissions>;
      getRun?: (id: string, cwd: string) => Promise<Run>;
      stateDirectory?: string;
      platform?: NodeJS.Platform;
      env?: NodeJS.ProcessEnv;
      home?: string;
      createAgent?: CreateCursorHarnessAgent;
      resumeAgent?: (id: string, config: AgentOptions) => Promise<Agent>;
    } = {},
  ) {
    this.options = new Map(options.map((option) => [option.model, option]));
    this.platform = platform;
    this.stateDirectory =
      stateDirectory ??
      path.join(
        platform === 'win32' ? (env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')) : home,
        '.cursor',
        'multi-harness',
      );
    this.cwd = cwd;
    this.checkPermissions = checkPermissions;
    this.getRun = getRun;
    this.resumeAgent = resumeAgent;
    this.createAgent = createAgent;
    this.store = new HarnessSessionStore<SavedSession, CursorRuntime>({
      provider: 'Cursor',
      stateDirectory: this.stateDirectory,
      platform,
      version: 3,
      fresh: (identity) => ({ version: 3, provider: 'Cursor', identity, interrupted: false }),
      validate: (saved) =>
        typeof saved.agentId === 'string' &&
        saved.agentId.length > 0 &&
        validPendingRun(saved.pendingRun),
      runtime: () => ({}),
      aliasFiles: (identity) => [legacyCursorSessionFile(this.stateDirectory, identity)],
      restore: restoreCursorSession,
      validContentBlock: cursorContentBlock,
    });
  }

  private selection(body: MessagesRequest) {
    const option = this.options.get(body.model ?? '');
    if (!option) {
      throw new Error('Unknown Cursor model; use a model from the account catalog');
    }
    return cursorSelection(option, body.output_config?.effort);
  }

  validate(body: MessagesRequest, context?: PermissionContext) {
    this.selection(body);
    if (context) {
      cursorPermissionPolicy(context);
    }
    if (!body.messages?.length) {
      throw new Error('Cursor requires a conversation');
    }
    return prepareCursorRequest(body).inputTokens;
  }

  /**
   * The native record key: one agent per working directory and worker scope. The
   * array shape is load-bearing, because `sessionScope` reads the scope back out
   * of it; the store hashes the whole key into the record's file name.
   */
  private identity(scope: string) {
    return JSON.stringify([this.cwd, scope]);
  }

  /** Fetch Cursor's billed usage on demand; this is not inferred from turn tokens. */
  async billedUsage(scope: string): Promise<
    Array<{
      agentId: string;
      scope: string;
      usage: AgentUsage['usage'];
      cost?: AgentUsage['cost'];
      runs: AgentUsage['runs'];
    }>
  > {
    const identity = this.identity(scope);
    const active = [...this.store.sessions()].find((session) => session.identity === identity);
    let agent = active?.runtime.agent;
    let temporary = false;
    if (!agent) {
      // A billing query never takes the record lock; it only needs the agent id.
      const restored = await restoreCursorSession({
        identity,
        files: [
          this.store.sessionFile(identity),
          legacyCursorSessionFile(this.stateDirectory, identity),
        ],
        read: readJson,
      });
      const agentId = savedAgentId(restored.saved);
      if (!agentId) {
        return [];
      }
      agent = await this.resumeAgent(agentId, {});
      temporary = true;
    }
    this.usageReaders.set(agent, (this.usageReaders.get(agent) ?? 0) + 1);
    try {
      if (!agent.getUsage) {
        return [];
      }
      const usage = await boundedUsage(agent.getUsage());
      return [
        { agentId: agent.agentId, scope, usage: usage.usage, cost: usage.cost, runs: usage.runs },
      ];
    } finally {
      const remaining = (this.usageReaders.get(agent) ?? 1) - 1;
      if (remaining) {
        this.usageReaders.set(agent, remaining);
      } else {
        this.usageReaders.delete(agent);
      }
      if (temporary) {
        this.closeAgent(agent);
      }
    }
  }

  async billedUsageForSession(sessionId: string) {
    const scopes = [...this.store.sessions()]
      .map((session) => sessionScope(session.identity))
      .filter((scope): scope is string => {
        try {
          const parsed: unknown = JSON.parse(scope ?? '');
          return Array.isArray(parsed) && parsed[0] === sessionId;
        } catch {
          return false;
        }
      });
    if (scopes.length > 64) {
      throw new Error('Cursor billing query exceeds 64 active agents');
    }
    const deadline = Date.now() + 7000;
    const results: Awaited<ReturnType<CursorHarness['billedUsage']>> = [];
    for (let index = 0; index < scopes.length; index += 4) {
      if (Date.now() + billedUsageTimeoutMs > deadline) {
        throw new Error('Cursor billed usage session query timed out');
      }
      const batch = await Promise.all(
        scopes.slice(index, index + 4).map((scope) => this.billedUsage(scope)),
      );
      results.push(...batch.flat());
    }
    return results;
  }

  async handle(
    body: MessagesRequest,
    scope: string,
    signal: AbortSignal,
    emit?: Emit,
    context?: PermissionContext,
    rowObserver?: NativeRowObserver,
  ) {
    if (this.closed) {
      throw new Error('Cursor harness is closed');
    }
    signal.throwIfAborted();
    if (!context) {
      throw new Error('Cursor requires an explicit Claude permission context');
    }
    const permissions = mergeCursorPermissions(context, await this.checkPermissions());
    this.validate(body, permissions);
    this.cwd = await realpath(this.cwd);
    const key = hash([
      this.cwd,
      scope,
      { ...body, stream: undefined },
      cursorPermissionPolicy(permissions).identity,
    ]);
    let exchange = this.registry.get(key);
    if (!exchange) {
      // Keep failed/finished requests too: a transport retry must never repeat native edits.
      if (this.registry.size >= maximumExchanges && !this.registry.evictSettled()) {
        throw new Error('Too many concurrent Cursor requests');
      }
      exchange = this.startExchange(body, scope, key, permissions, rowObserver);
    }
    return this.registry.observe(exchange, signal, emit);
  }

  private startExchange(
    body: MessagesRequest,
    scope: string,
    key: string,
    context: PermissionContext,
    rowObserver?: NativeRowObserver,
  ): CursorExchange {
    return this.registry.start(
      key,
      async (exchange, emit) => {
        const response = await this.cachedExecute(
          body,
          scope,
          key,
          exchange,
          emit,
          context,
          rowObserver,
        );
        exchange.meta.succeeded = true;
        return response;
      },
      {
        // A finished turn stays addressable so a retry replays it. A failed turn
        // that may have run stays too, so its uncertainty is reported instead of
        // repeating native edits; a failure that provably ran nothing is dropped.
        retain: (exchange) => {
          const state = exchange.meta;
          return state.succeeded === true || (state.mayHaveRun === true && !state.committed);
        },
      },
    );
  }

  private async cachedExecute(
    body: MessagesRequest,
    scope: string,
    key: string,
    exchange: CursorExchange,
    emit: Emit,
    context: PermissionContext,
    rowObserver?: NativeRowObserver,
  ): Promise<MessagesResponse> {
    const lease = await this.takeTurn(scope);
    const session = lease.session;
    try {
      if (session.saved.interrupted) {
        await this.recoverSession(session);
      }
      const cached = await replayPersisted({
        stateDirectory: this.stateDirectory,
        key,
        saved: session.saved,
        emit,
        provider: 'Cursor',
        validContentBlock: cursorContentBlock,
      });
      if (cached !== undefined) {
        return cached;
      }
      return await this.execute(body, session, key, exchange, emit, context, rowObserver);
    } finally {
      if (this.closed) {
        this.closeAgent(session.runtime.agent);
      }
      await lease.release();
    }
  }

  private async recoverSession(session: Session) {
    const pending = session.saved.pendingRun;
    if (!pending || !session.saved.agentId) {
      return;
    }
    const recovered = await this.recoverRun(pending, session.saved.agentId);
    if (!recovered) {
      return;
    }
    session.saved.interrupted = false;
    session.saved.pendingRun = undefined;
    session.saved.response = recovered.response;
    session.saved.replay = { key: pending.key, events: recovered.events };
    await this.store.save(session);
  }

  /** A readable terminal result; every other outcome leaves the run's status unknown. */
  private async recoverRun(pending: PendingRun, agentId: string) {
    if (!pending.runId) {
      return undefined;
    }
    const run = await this.getRun(pending.runId, this.cwd);
    if (run.id !== pending.runId || run.agentId !== agentId) {
      return undefined;
    }
    // Detached local records can retain QUEUED/CREATING/RUNNING after a crash;
    // this status is not evidence that another gateway still owns a live turn.
    if (run.status === 'running' || !run.supports('wait')) {
      return undefined;
    }
    const result = await run.wait();
    if (result.id !== pending.runId || result.status !== 'finished') {
      return undefined;
    }
    const events: HarnessEvent[] = [];
    const response = new HarnessResponse(pending.model, pending.inputTokens, (name, value) => {
      events.push([name, structuredClone(value)]);
    });
    response.text(result.result ?? '');
    const finished = response.finish(cursorUsage(result.usage), pending.model, pending.effort);
    events.push(...response.takeTerminalEvents());
    return { response: finished, events };
  }

  /** Reserve an SDK slot before awaiting creation or resume. Replay uses no slot. */
  private reserveAgent(session: Session): void {
    const records = [...this.store.sessions()];
    const agents = records.filter(
      (item) =>
        item.runtime.agent &&
        !this.closedAgents.has(item.runtime.agent) &&
        !this.attaching.has(item),
    );
    if (agents.length + this.attaching.size >= maximumAgents) {
      const idle = agents.find(
        (item) =>
          !item.busy &&
          !this.attaching.has(item) &&
          (!item.runtime.agent || !this.usageReaders.has(item.runtime.agent)),
      );
      if (!idle) {
        throw new Error('Too many concurrent Cursor agents');
      }
      this.closeAgent(idle.runtime.agent);
      idle.runtime.agent = undefined;
      idle.runtime.policy = undefined;
    }
    this.attaching.add(session);
  }

  /** One turn at a time per agent: a prompt that arrives during a run is refused. */
  private async takeTurn(scope: string): Promise<TurnLease> {
    try {
      return await this.store.acquireLease(this.identity(scope));
    } catch (error) {
      throw error instanceof HarnessBusyError ? new CursorProviderError(error) : error;
    }
  }

  /** Attach the native SDK agent the record names, or create its first one. */
  private async ready(
    session: Session,
    body: MessagesRequest,
    context: PermissionContext,
  ): Promise<ReadySession> {
    const attached = session.runtime.agent;
    if (attached && !this.closedAgents.has(attached)) {
      return Object.assign(session, { runtime: { ...session.runtime, agent: attached } });
    }
    this.reserveAgent(session);
    const previousId = session.saved.agentId;
    let agent: Agent | undefined;
    try {
      const config = {
        ...(await cursorNativePermissions(this.cwd, context)),
        model: this.selection(body),
      };
      agent = session.saved.agentId
        ? await this.resumeAgent(session.saved.agentId, config)
        : await this.createAgent(config);
      if (this.closed) {
        this.closeAgent(agent);
        throw new Error('Cursor harness is closed');
      }
      session.runtime.agent = agent;
      session.saved.agentId = agent.agentId;
      session.runtime.policy = cursorPermissionPolicy(context).identity;
      await this.store.save(session);
      return Object.assign(session, { runtime: { ...session.runtime, agent } });
    } catch (error) {
      if (agent) {
        this.closeAgent(agent);
      }
      session.runtime.agent = undefined;
      session.runtime.policy = undefined;
      session.saved.agentId = previousId;
      throw error;
    } finally {
      this.attaching.delete(session);
    }
  }

  private async configureSession(
    session: ReadySession,
    body: MessagesRequest,
    context: PermissionContext,
  ) {
    const config = await cursorNativePermissions(this.cwd, context);
    const policy = cursorPermissionPolicy(context).identity;
    if (session.runtime.policy === policy && !this.closedAgents.has(session.runtime.agent)) {
      return;
    }
    // Tools are agent-level SDK options. Resume the same conversation with the new policy.
    this.closeAgent(session.runtime.agent);
    this.reserveAgent(session);
    try {
      session.runtime.agent = await this.resumeAgent(session.runtime.agent.agentId, {
        ...config,
        model: this.selection(body),
      });
      session.runtime.policy = policy;
    } finally {
      this.attaching.delete(session);
    }
  }

  private async persistDispatch(
    session: Session,
    key: string,
    model: string,
    inputTokens: number,
    effort?: string,
  ) {
    session.saved.pendingRun = { key, model, inputTokens, effort };
    // Durability write: a gateway crash before a terminal result arrives leaves
    // the session interrupted, so the next request resumes it with a notice
    // instead of guessing what the dispatched run did.
    session.saved.interrupted = true;
    await this.store.save(session);
    return session.saved.pendingRun;
  }

  private async execute(
    body: MessagesRequest,
    held: Session,
    key: string,
    exchange: CursorExchange,
    emit: Emit,
    context: PermissionContext,
    rowObserver?: NativeRowObserver,
  ) {
    const signal = exchange.controller.signal;
    signal.throwIfAborted();
    const messages = held.saved.response ? continuation(body, 'Cursor') : (body.messages ?? []);
    const rewound = historyRewound(held.saved, body.messages ?? [], harnessHistoryHash);
    const session = await this.ready(held, body, context);
    let text = '';
    let cancelled = false;
    let dispatched = false;
    const cancel = () => {
      if (session.runtime.run && !cancelled) {
        cancelled = true;
        const run = session.runtime.run;
        void Promise.resolve()
          .then(() => run.cancel())
          .catch(() => {});
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const prepared = prepareCursorRequest({ ...body, messages });
      if (session.saved.interrupted) {
        prepared.prompt.text = `${interruptedNotice('Cursor')}\n\n${prepared.prompt.text ?? ''}`;
      }
      const stream = new HarnessResponse(body.model ?? '', prepared.inputTokens, emit, {
        multiBlock: true,
      });
      writeNotices(stream, {
        tag: 'Cursor',
        interrupted: session.saved.interrupted,
        rewound,
        noticeChanged: false,
      });
      signal.throwIfAborted();
      if (this.closed) {
        throw new Error('Cursor harness is closed');
      }
      await this.configureSession(session, body, context);
      await archiveHarnessReply({
        session,
        stateDirectory: this.stateDirectory,
        platform: this.platform,
      });
      const selection = this.selection(body);
      const dispatch = await this.persistDispatch(
        session,
        key,
        selection.id,
        prepared.inputTokens,
        selectedEffort(selection),
      );
      dispatched = true;
      signal.throwIfAborted();
      exchange.meta.mayHaveRun = true;
      session.runtime.run = await this.dispatchRun(
        session,
        prepared.prompt,
        { model: selection, mode: cursorPermissionPolicy(context).mode },
        signal,
        stream,
        (delta) => {
          text += delta;
        },
        rowObserver,
      );
      dispatch.runId = session.runtime.run.id;
      await this.store.save(session);
      if (signal.aborted) {
        cancel();
      }
      const result = await settleOrAbort(session.runtime.run.wait(), signal, 'Cursor native run');
      // A readable terminal result, success or not, resolves the uncertainty.
      session.saved.interrupted = false;
      session.saved.pendingRun = undefined;
      signal.throwIfAborted();
      if (result.status !== 'finished') {
        throw cursorRunError(result);
      }
      const suffix = terminalSuffix(text, result.result ?? '');
      if (suffix) {
        rowObserver?.({ type: 'text', text: suffix });
      }
      stream.text(suffix);
      const response = stream.finish(
        cursorUsage(result.usage),
        selection.id,
        selectedEffort(selection),
      );
      return await commitHarnessResponse({
        session,
        store: this.store,
        response: stream,
        finished: response,
        exchange,
        key,
        emit,
        update: () => {},
        onCommitted: () => {
          exchange.meta.committed = true;
        },
      });
    } catch (error) {
      cancel();
      await this.recordUncertainty(session, dispatched, exchange.meta.mayHaveRun === true);
      throw error instanceof CursorProviderError ? error : new CursorProviderError(error);
    } finally {
      session.runtime.run = undefined;
      signal.removeEventListener('abort', cancel);
    }
  }

  private dispatchRun(
    session: ReadySession,
    prompt: ReturnType<typeof prepareCursorRequest>['prompt'],
    options: {
      model: ReturnType<CursorHarness['selection']>;
      mode: ReturnType<typeof cursorPermissionPolicy>['mode'];
    },
    signal: AbortSignal,
    stream: HarnessResponse,
    appendText: (delta: string) => void,
    rowObserver?: NativeRowObserver,
  ) {
    return session.runtime.agent.send(prompt, {
      ...options,
      onDelta: ({ update }) => {
        signal.throwIfAborted();
        const observation = rowObserver ? cursorRowObservation(update) : undefined;
        const display = observation ? rowObserver?.(observation) : undefined;
        if (display) {
          stream.displayRow(display);
        }
        if (update.type === 'text-delta') {
          appendText(update.text);
          stream.text(update.text);
        } else if (!rowObserver) {
          const progress = formatCursorProgress(update);
          if (progress) {
            stream.text(`\n${progress}\n`);
          }
        }
      },
    });
  }

  /** No dispatch record: nothing to reconcile. A dispatch that never reached the
   * SDK reverts its durability write; any real attempt keeps its current state. */
  private async recordUncertainty(session: Session, dispatched: boolean, mayHaveRun: boolean) {
    if (!dispatched) {
      return;
    }
    if (!mayHaveRun) {
      session.saved.interrupted = false;
      session.saved.pendingRun = undefined;
    }
    await this.store.save(session).catch(() => {
      // The error surfaced to the caller is the more useful failure.
    });
  }

  private closeAgent(agent: Agent | undefined) {
    if (!agent || this.closedAgents.has(agent)) {
      return;
    }
    this.closedAgents.add(agent);
    try {
      agent.close();
    } catch {
      /* SDK cleanup failure must not prevent releasing finished session locks. */
    }
  }

  async close() {
    this.closed = true;
    for (const exchange of this.registry.all()) {
      if (!exchange.settled) {
        exchange.controller.abort(new Error('Cursor gateway closed'));
      }
    }
    await bounded(Promise.allSettled(this.registry.all().map((exchange) => exchange.result)));
    for (const session of [...this.store.sessions()]) {
      this.closeAgent(session.runtime.agent);
    }
    await this.store.closeAll();
  }
}

function validPendingRun(pending: PendingRun | undefined) {
  return (
    pending === undefined ||
    (pending !== null &&
      isHash(pending.key) &&
      typeof pending.model === 'string' &&
      Number.isSafeInteger(pending.inputTokens) &&
      pending.inputTokens >= 0 &&
      (pending.runId === undefined ||
        (typeof pending.runId === 'string' && pending.runId.length > 0)))
  );
}

/** The worker scope inside a record identity; the record file keys on both. */
function sessionScope(identity: string): string | undefined {
  const parsed: unknown = JSON.parse(identity);
  return Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : undefined;
}

function savedAgentId(saved: unknown): string | undefined {
  if (!isRecord(saved) || typeof saved.agentId !== 'string' || !saved.agentId) {
    return undefined;
  }
  return saved.agentId;
}

async function bounded(operation: Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

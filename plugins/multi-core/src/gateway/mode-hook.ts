import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { nativeSpelling } from '../../../multi-antigravity/src/models.ts';
import { mergeCursorPermissions } from '../../../multi-cursor/src/permissions.ts';
import type { WorkerPermissions } from './agent-definitions.ts';
import { ModPolicies } from './mod-policy.ts';
import { type ResolvedWorker, resolveWorker, type WorkerCatalog } from './worker-catalog.ts';

const MODES = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'] as const;
type PermissionMode = (typeof MODES)[number];
type WorkerExecution = 'claude' | 'harness';
export interface PermissionContext extends WorkerPermissions {
  permissionMode: PermissionMode;
  cwd?: string;
  model?: string;
  compaction?: string;
}

function permissionMode(value: unknown): PermissionMode {
  if (!MODES.includes(value as PermissionMode)) {
    throw new Error('Missing or unsupported Claude permission mode');
  }
  return value as PermissionMode;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096) {
    throw new Error(`Missing or invalid hook ${name}`);
  }
  return value;
}

function executionForModel(model: unknown): WorkerExecution {
  if (typeof model !== 'string') {
    return 'claude';
  }
  return model.startsWith('multi/cursor/') ||
    model.startsWith('multi/antigravity/') ||
    model.startsWith('multi/grok/')
    ? 'harness'
    : 'claude';
}

/** Prompt-time snapshots: the existing selector takes effect at the next prompt. */
export class PermissionModes {
  readonly policies: ModPolicies;
  private readonly compactions = new Map<string, { id: string; previous: PermissionContext }>();
  private readonly parents = new Map<string, PermissionContext>();
  private readonly hostOnly = new Set<string>();
  /** The last admitted settings restrictions per session, retained across host snapshots. */
  private readonly admitted = new Map<string, WorkerPermissions>();
  private readonly workers = new Map<
    string,
    WorkerPermissions & { cwd: string; compaction?: string }
  >();
  private readonly pendingWorkers = new Map<
    string,
    WorkerPermissions & { cwd: string; type: string; expiresAt: number }
  >();
  private readonly catalogs = new Map<string, Record<string, WorkerPermissions>>();
  /** Last start refusal per worker, so a later harness request can explain it. */
  private readonly refusals = new Map<string, { reason: string; at: number }>();
  private readonly definitions: (cwd: string) => Promise<Record<string, WorkerPermissions>>;
  private readonly platform: NodeJS.Platform;
  /** The provider worker types, whose Agent-call `model` is resolved here. */
  private readonly workerCatalog: WorkerCatalog;

  constructor(
    definitions: (cwd: string) => Promise<Record<string, WorkerPermissions>>,
    restrictions: (cwd: string) => Promise<WorkerPermissions> = async () => ({}),
    options: { platform?: NodeJS.Platform; workers?: WorkerCatalog } = {},
  ) {
    this.definitions = definitions;
    this.platform = options.platform ?? process.platform;
    this.workerCatalog = options.workers ?? {};
    this.policies = new ModPolicies(async (cwd) => ({
      cwd,
      workers: await definitions(cwd),
      restrictions: await restrictions(cwd),
    }));
  }

  beginPolicy(session: string, cwd: string) {
    this.parents.delete(session);
    for (const key of this.compactions.keys()) {
      if (JSON.parse(key)[0] === session) {
        this.compactions.delete(key);
      }
    }
    for (const key of this.pendingWorkers.keys()) {
      if (JSON.parse(key)[0] === session) {
        this.pendingWorkers.delete(key);
      }
    }
    return this.policies.begin(session, cwd);
  }

  admitPolicy(session: string, generation: string, context: PermissionContext) {
    const policy = this.policies.consume(session, generation, requiredString(context.cwd, 'cwd'));
    remember(this.catalogs, policy.cwd, policy.workers);
    this.recordModSession(session, {
      ...mergeCursorPermissions(context, policy.restrictions),
      nativePermissionError: policy.restrictions.nativePermissionError,
    });
    remember(this.admitted, session, structuredClone(policy.restrictions));
  }

  async precompute(cwd: string): Promise<void> {
    const catalog = await this.definitions(cwd);
    remember(this.catalogs, cwd, structuredClone(catalog));
  }

  offered(cwd: string, type: string): boolean {
    const catalog = this.catalogs.get(cwd);
    return Boolean(catalog && Object.hasOwn(catalog, type) && !catalog[type].nativePermissionError);
  }

  recordModSession(session: string, context: PermissionContext): void {
    this.parents.delete(session);
    this.hostOnly.delete(session);
    permissionMode(context.permissionMode);
    remember(this.parents, session, structuredClone(context));
  }

  /**
   * A Claude-loop snapshot records identity, but grants no external harness execution
   * to the main loop. It does not revoke harness workers already acknowledged under an
   * admitted policy; those keep that policy's restrictions (see resolveHarness).
   */
  recordHostSession(session: string, context: PermissionContext): void {
    this.recordModSession(session, context);
    this.hostOnly.add(session);
  }

  resolveHarness(session: string, agent?: string, model?: string): PermissionContext {
    if (agent && !this.workers.has(JSON.stringify([session, agent]))) {
      const refusal = this.refusals.get(JSON.stringify([session, agent]));
      const detail = refusal
        ? ` Spawn acknowledgement failed at ${new Date(refusal.at).toISOString()}: ${refusal.reason}.`
        : '';
      throw new Error(
        `Native harness worker has no acknowledged spawn.${detail} Workflow-started native workers are unsupported until Claude Code supplies spawn context; use the Agent tool instead. If this came from the Agent tool, submit a new prompt and retry.`,
      );
    }
    if (this.hostOnly.has(session) && !(agent && this.admitted.has(session))) {
      throw new Error(
        'Native harness settings policy has not been admitted. If starting a native worker from a Workflow, use the Agent tool instead; Workflow starts lack the spawn context needed for safe admission.',
      );
    }
    const context = this.hostOnly.has(session)
      ? this.withAdmittedPolicy(session, this.resolve(session, agent))
      : this.resolve(session, agent);
    if (model && context.model && !sameModel(context.model, model)) {
      throw new Error('Harness model is inconsistent with its admitted permission context');
    }
    return context;
  }

  /** Reapply the admitted settings restrictions a later host snapshot does not carry. */
  private withAdmittedPolicy(session: string, context: PermissionContext): PermissionContext {
    const restrictions = this.admitted.get(session) ?? {};
    return {
      ...mergeCursorPermissions(context, restrictions),
      nativePermissionError: context.nativePermissionError ?? restrictions.nativePermissionError,
    };
  }

  recordModWorker(
    session: string,
    agent: string,
    context: WorkerPermissions & { cwd?: string; compaction?: string },
  ): void {
    remember(this.workers, JSON.stringify([session, agent]), {
      cwd: context.cwd ?? process.cwd(),
      model: context.model,
      compaction: context.compaction,
      permissionMode: context.permissionMode,
      tools: context.tools?.slice(),
      disallowedTools: context.disallowedTools?.slice(),
      ...(context.nativePermissionError
        ? { nativePermissionError: context.nativePermissionError }
        : {}),
    });
  }

  async prepareModWorker(session: string, input: Record<string, unknown>): Promise<string> {
    const type = requiredString(input.subagentType, 'subagentType');
    const cwd = requiredString(input.cwd, 'cwd');
    const parent = this.resolve(
      session,
      typeof input.parentAgentId === 'string' ? input.parentAgentId : undefined,
    );
    validateWorkerRequest(input, parent, cwd);
    const selection = this.workerSelection(input);
    const definition = input.fork === true ? {} : this.catalogs.get(cwd)?.[type];
    if (!definition) {
      throw new Error(`Cannot resolve permissions for Claude worker ${type}`);
    }
    const model = selection.model;
    if (selection.execution === 'harness') {
      this.resolveHarness(session);
      // A provider worker's model was resolved against its catalog, not its default.
      validateWorkerDefinition(definition, input, !selection.worker);
      if (parent.nativePermissionError) {
        throw new Error(parent.nativePermissionError);
      }
    }
    this.prunePendingWorkers();
    const token = randomUUID();
    const inherited = input.parentAgentId ? mergeCursorPermissions(parent, definition) : definition;
    remember(this.pendingWorkers, JSON.stringify([session, token]), {
      ...inherited,
      cwd,
      type,
      expiresAt: Date.now() + 15000,
      model,
      permissionMode: definition.permissionMode ?? parent.permissionMode,
      nativePermissionError: definition.nativePermissionError,
    });
    return token;
  }

  /**
   * Classify from the catalog and pinned parent model, never from a worker name. A
   * provider worker's model is the Agent call's `model` resolved against its catalog;
   * an unknown or other provider's model throws with the provider's models named.
   */
  workerSelection(input: Record<string, unknown>): {
    model?: string;
    execution: WorkerExecution;
    known: boolean;
    worker?: ResolvedWorker;
  } {
    const type = requiredString(input.subagentType, 'subagentType');
    const cwd = requiredString(input.cwd, 'cwd');
    const explicit = input.model === undefined ? undefined : requiredString(input.model, 'model');
    const parent =
      input.parentModel === undefined
        ? undefined
        : requiredString(input.parentModel, 'parentModel');
    const definition = this.catalogs.get(cwd)?.[type];
    if (input.fork === true) {
      return { model: parent, execution: executionForModel(parent), known: true };
    }
    if (Object.hasOwn(this.workerCatalog, type)) {
      const worker = resolveWorker(this.workerCatalog, type, explicit);
      return {
        model: worker.model,
        execution: executionForModel(worker.model),
        known: definition !== undefined,
        worker,
      };
    }
    const fixed =
      definition?.model && definition.model !== 'inherit' ? definition.model : undefined;
    const model = fixed ?? (explicit === 'inherit' ? parent : explicit) ?? parent;
    return { model, execution: executionForModel(model), known: definition !== undefined };
  }

  private prunePendingWorkers() {
    for (const [key, pending] of this.pendingWorkers) {
      if (pending.expiresAt <= Date.now()) {
        this.pendingWorkers.delete(key);
      }
    }
  }

  /**
   * Bind SubagentStart to the one pending Agent-tool spawn it acknowledges. Claude
   * starts an `isolation: "worktree"` worker in `<spawn cwd>/.claude/worktrees/<name>`,
   * so that exact child path also matches. The worker records its actual start cwd
   * for workspace routing, while settings admission stays keyed to the spawn cwd:
   * a worktree of an admitted checkout inherits that checkout's admitted policy
   * (worktrees do not receive the parent's untracked settings.local.json). No other
   * cwd, including any other subdirectory, is accepted.
   */
  startPreparedModWorker(session: string, agent: string, type: string, cwd: string): void {
    try {
      const candidates = [...this.pendingWorkers].filter(
        ([key, value]) =>
          JSON.parse(key)[0] === session &&
          value.type === type &&
          value.expiresAt > Date.now() &&
          (value.cwd === cwd || isClaudeWorktreeOf(value.cwd, cwd, this.platform)),
      );
      if (candidates.length !== 1) {
        throw new Error(
          `Worker start has no unique acknowledged spawn (${this.startMismatch(session, type, cwd, candidates.length)})`,
        );
      }
      const [key] = candidates[0];
      this.recordPreparedModWorker(session, agent, JSON.parse(key)[1], cwd);
      this.refusals.delete(JSON.stringify([session, agent]));
    } catch (error) {
      this.recordRefusal(session, agent, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private startMismatch(session: string, type: string, cwd: string, matches: number): string {
    if (matches > 1) {
      return `${matches} pending ${type} spawns match start=${cwd}`;
    }
    const pending = [...this.pendingWorkers]
      .filter(([key, value]) => JSON.parse(key)[0] === session && value.type === type)
      .map(([, value]) => value);
    if (pending.length === 0) {
      return `no pending ${type} spawn for start=${cwd}`;
    }
    if (pending.every((value) => value.expiresAt <= Date.now())) {
      return `pending ${type} spawn expired`;
    }
    const parents = pending.map((value) => value.cwd).join(', ');
    return `cwd mismatch parent=${parents} start=${cwd}`;
  }

  private recordRefusal(session: string, agent: string, reason: string) {
    const key = JSON.stringify([session, agent]);
    this.refusals.delete(key);
    // Diagnostics only: evict the oldest entry rather than refusing new work.
    const oldest = this.refusals.keys().next();
    if (this.refusals.size >= 256 && !oldest.done) {
      this.refusals.delete(oldest.value);
    }
    this.refusals.set(key, { reason: reason.slice(0, 2048), at: Date.now() });
  }

  recordPreparedModWorker(session: string, agent: string, token: unknown, cwd?: string): void {
    requiredString(agent, 'agentId');
    if (this.workers.has(JSON.stringify([session, agent]))) {
      throw new Error('Worker identity is already registered');
    }
    const workerToken = requiredString(token, 'workerToken');
    const key = JSON.stringify([session, workerToken]);
    const context = this.pendingWorkers.get(key);
    this.pendingWorkers.delete(key);
    if (!context || context.expiresAt <= Date.now()) {
      throw new Error('Worker policy acknowledgement is unavailable');
    }
    this.recordModWorker(session, agent, cwd ? { ...context, cwd } : context);
  }

  authorizeModCompaction(session: string, agent?: string): void {
    const current = this.resolveHarness(session, agent);
    const key = JSON.stringify([session, agent ?? 'main']);
    const previous = this.compactions.get(key)?.previous ?? current;
    const context = { ...current, tools: [], compaction: randomUUID() };
    remember(this.compactions, key, { id: context.compaction, previous });
    if (agent) {
      this.recordModWorker(session, agent, context);
    } else {
      this.recordModSession(session, context);
    }
  }

  /** Arm a tool-free boundary when SessionStart restored no prompt snapshot. */
  authorizeRestoredModCompaction(session: string): void {
    if (this.parents.has(session)) {
      this.authorizeModCompaction(session);
      return;
    }
    this.recordModSession(session, { permissionMode: 'default', tools: [], disallowedTools: [] });
    this.authorizeModCompaction(session);
  }

  finishModCompaction(session: string, agent: string | undefined, id: string | undefined): void {
    const key = JSON.stringify([session, agent ?? 'main']);
    const saved = this.compactions.get(key);
    if (!id || saved?.id !== id) {
      return;
    }
    this.compactions.delete(key);
    if (this.resolve(session, agent).compaction !== id) {
      return;
    }
    if (agent) {
      this.recordModWorker(session, agent, saved.previous);
    } else {
      this.recordModSession(session, saved.previous);
    }
  }

  async record(input: Record<string, unknown>): Promise<void> {
    const session = requiredString(input.session_id, 'session_id');
    if (input.hook_event_name === 'UserPromptSubmit') {
      // Clear first: a malformed new snapshot must not retain earlier permissions.
      this.parents.delete(session);
      remember(this.parents, session, { permissionMode: permissionMode(input.permission_mode) });
      return;
    }
    if (input.hook_event_name !== 'SubagentStart') {
      throw new Error('Unsupported mode hook event');
    }
    const agent = requiredString(input.agent_id, 'agent_id');
    const key = JSON.stringify([session, agent]);
    this.workers.delete(key);
    const type = requiredString(input.agent_type, 'agent_type');
    const cwd = requiredString(input.cwd, 'cwd');
    const definitions = await this.definitions(cwd);
    const definition = Object.hasOwn(definitions, type) ? definitions[type] : undefined;
    if (!definition) {
      throw new Error(`Cannot resolve permissions for Claude worker ${type}`);
    }
    remember(this.workers, key, {
      cwd,
      model:
        definition.model === 'inherit'
          ? this.parents.get(session)?.model
          : (definition.model ?? this.parents.get(session)?.model),
      // A definition without a mode inherits the parent's at resolve time.
      permissionMode: definition.permissionMode,
      tools: definition.tools?.slice(),
      disallowedTools: definition.disallowedTools?.slice(),
      ...(definition.nativePermissionError
        ? { nativePermissionError: definition.nativePermissionError }
        : {}),
    });
  }

  forgetSession(session: string): void {
    this.parents.delete(session);
    this.hostOnly.delete(session);
    this.admitted.delete(session);
    this.policies.forget(session);
    for (const entries of [this.workers, this.pendingWorkers, this.compactions, this.refusals]) {
      for (const key of entries.keys()) {
        if (JSON.parse(key)[0] === session) {
          entries.delete(key);
        }
      }
    }
  }

  resolve(session: string, agent?: string): PermissionContext {
    const parent = this.parents.get(session);
    if (!parent) {
      throw new Error('Claude permission mode is unavailable; submit a new prompt');
    }
    if (!agent) {
      return structuredClone(parent);
    }
    const worker = this.workers.get(JSON.stringify([session, agent]));
    if (!worker) {
      throw new Error('Claude worker permission context is unavailable');
    }
    const inherited = ['auto', 'acceptEdits', 'bypassPermissions'].includes(parent.permissionMode);
    return mergeCursorPermissions(
      {
        ...worker,
        nativePermissionError: worker.nativePermissionError ?? parent.nativePermissionError,
        ...(parent.compaction ? { compaction: parent.compaction } : {}),
        permissionMode: inherited
          ? parent.permissionMode
          : permissionMode(worker.permissionMode ?? parent.permissionMode),
      },
      parent,
    );
  }
}

/** True when `candidate` is exactly `<parent>/.claude/worktrees/<name>`. */
function isClaudeWorktreeOf(
  parent: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const relative = paths.relative(parent, candidate);
  if (!relative || paths.isAbsolute(relative)) {
    return false;
  }
  const parts = relative.split(paths.sep);
  return (
    parts.length === 3 &&
    parts[0] === '.claude' &&
    parts[1] === 'worktrees' &&
    parts[2] !== '' &&
    parts[2] !== '.' &&
    parts[2] !== '..'
  );
}

/** Claude's context tag is presentation metadata, so two spellings name one model. */
function sameModel(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return left === right;
  }
  return nativeSpelling(left) === nativeSpelling(right);
}

function validateWorkerDefinition(
  definition: WorkerPermissions,
  input: Record<string, unknown>,
  fixedModel = true,
) {
  if (definition.nativePermissionError) {
    throw new Error(definition.nativePermissionError);
  }
  if (
    fixedModel &&
    definition.model &&
    definition.model !== 'inherit' &&
    input.model !== undefined &&
    !sameModel(input.model, definition.model)
  ) {
    throw new Error('Worker model is inconsistent with its catalog definition');
  }
}

function validateWorkerRequest(
  input: Record<string, unknown>,
  parent: PermissionContext,
  cwd: string,
) {
  if (permissionMode(input.permissionMode) !== parent.permissionMode) {
    throw new Error('Worker parent permission mode is inconsistent');
  }
  if (
    parent.model &&
    !sameModel(input.parentModel, parent.model) &&
    (executionForModel(parent.model) === 'harness' ||
      executionForModel(input.parentModel) === 'harness')
  ) {
    throw new Error('Worker parent model is inconsistent');
  }
  if (parent.cwd && parent.cwd !== cwd) {
    throw new Error('Worker workspace has no acknowledged policy');
  }
}

function remember<T>(entries: Map<string, T>, key: string, value: T): void {
  // ponytail: cap lifetime identities; add lifecycle cleanup if long sessions reach this limit.
  if (!entries.has(key) && entries.size >= 4096) {
    throw new Error('Claude permission context limit reached; restart the gateway');
  }
  entries.set(key, value);
}

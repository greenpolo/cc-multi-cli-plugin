import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { WorkerPermissions } from './agent-definitions.ts';
import { setBounded } from './bounded.ts';
import { mergePermissions } from './harness-settings.ts';
import { harnessProvider, workerTypeName } from './provider.ts';
import { type ResolvedWorker, resolveWorker, type WorkerCatalog } from './worker-catalog.ts';

const MODES = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'] as const;
type PermissionMode = (typeof MODES)[number];
type WorkerExecution = 'claude' | 'harness';
const MAX_ENTRIES = 4096;
export interface PermissionContext extends WorkerPermissions {
  permissionMode: PermissionMode;
  cwd?: string;
  model?: string;
  compaction?: string;
}

/** A mode this gateway does not know is treated as Claude's default; a native run uses Auto for it. */
function permissionMode(value: unknown): PermissionMode {
  return MODES.find((mode) => mode === value) ?? 'default';
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096) {
    throw new Error(`Missing or invalid hook ${name}`);
  }
  return value;
}

function executionForModel(model: unknown): WorkerExecution {
  return harnessProvider(model) ? 'harness' : 'claude';
}

/**
 * One record per session: the permission mode, workspace and model of its latest prompt.
 * A worker adds its agent type's own tool rules and otherwise inherits the session's
 * record. Nothing here refuses a run: a session or worker the hooks have not reported
 * yet resolves to the session's record, or to Auto without one.
 */
export class PermissionModes {
  /**
   * Armed compaction boundaries, keyed by exactly one [session, 'main' | worker]. The
   * main loop's boundary is applied by `resolve` and never written into its record,
   * so no worker inherits it; a worker's `previous` is what it ran under before.
   */
  private readonly compactions = new Map<string, { id: string; previous?: PermissionContext }>();
  private readonly sessions = new Map<string, PermissionContext>();
  private readonly workers = new Map<
    string,
    WorkerPermissions & { cwd: string; compaction?: string }
  >();
  /** Agent calls not yet started, oldest first: what each start inherits from its parent. */
  private readonly spawns = new Map<
    string,
    WorkerPermissions & { cwd: string; type: string; expiresAt: number }
  >();
  private readonly catalogs = new Map<string, Record<string, WorkerPermissions>>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly definitions: (cwd: string) => Promise<Record<string, WorkerPermissions>>;
  private readonly platform: NodeJS.Platform;
  /** The provider worker types, whose Agent-call `model` is resolved here. */
  private readonly workerCatalog: WorkerCatalog;

  constructor(
    definitions: (cwd: string) => Promise<Record<string, WorkerPermissions>>,
    options: { platform?: NodeJS.Platform; workers?: WorkerCatalog } = {},
  ) {
    this.definitions = definitions;
    this.platform = options.platform ?? process.platform;
    this.workerCatalog = options.workers ?? {};
  }

  /**
   * The agent definitions of a workspace, read once and then refreshed behind each prompt.
   * A workspace whose definitions cannot be read has none; its workers inherit the session.
   */
  async ready(cwd: string): Promise<void> {
    if (!this.catalogs.has(cwd)) {
      await this.refresh(cwd);
    }
  }

  private refresh(cwd: string): Promise<void> {
    const running = this.loading.get(cwd);
    if (running) {
      return running;
    }
    const load = this.definitions(cwd)
      .then(
        (catalog) => remember(this.catalogs, cwd, structuredClone(catalog)),
        () => {
          if (!this.catalogs.has(cwd)) {
            remember(this.catalogs, cwd, {});
          }
        },
      )
      .finally(() => this.loading.delete(cwd));
    this.loading.set(cwd, load);
    return load;
  }

  offered(cwd: string, type: string): boolean {
    const catalog = this.catalogs.get(cwd);
    return Boolean(catalog && Object.hasOwn(catalog, workerTypeName(type)));
  }

  /** The prompt-boundary record: every provider reads the mode Claude Code is in from it. */
  recordSession(session: string, context: PermissionContext): void {
    remember(this.sessions, session, {
      ...structuredClone(context),
      permissionMode: permissionMode(context.permissionMode),
    });
    if (context.cwd) {
      void this.refresh(context.cwd);
    }
  }

  /** The context a native run answers to; the request's own model names what runs. */
  resolveHarness(session: string, agent?: string, model?: string): PermissionContext {
    const context = this.resolve(session, agent);
    return model ? { ...context, model } : context;
  }

  private recordWorker(
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
    });
  }

  /**
   * An Agent call is about to start a worker: remember what it inherits from the loop
   * that called it. The worker itself is recorded when Claude Code reports its start.
   */
  prepareWorker(session: string, input: Record<string, unknown>): void {
    const type = workerTypeName(requiredString(input.subagentType, 'subagentType'));
    const cwd = requiredString(input.cwd, 'cwd');
    const selection = this.workerSelection(input);
    const definition = input.fork === true ? {} : (this.catalogs.get(cwd)?.[type] ?? {});
    const parentAgent = typeof input.parentAgentId === 'string' ? input.parentAgentId : undefined;
    const inherited = parentAgent
      ? mergePermissions(this.resolve(session, parentAgent), definition)
      : definition;
    this.pruneSpawns();
    remember(this.spawns, JSON.stringify([session, randomUUID()]), {
      tools: inherited.tools,
      disallowedTools: inherited.disallowedTools,
      cwd,
      type,
      expiresAt: Date.now() + 60_000,
      model: selection.model,
      // Only an explicit mode is stored; an inherited one follows the session at resolve time.
      permissionMode: definition.permissionMode,
    });
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
    const type = workerTypeName(requiredString(input.subagentType, 'subagentType'));
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

  private pruneSpawns() {
    for (const [key, spawn] of this.spawns) {
      if (spawn.expiresAt <= Date.now()) {
        this.spawns.delete(key);
      }
    }
  }

  /**
   * Claude Code reports a worker's start. It takes the oldest waiting Agent call of its
   * type, so several workers of one provider started together each get a record; Claude
   * starts an `isolation: "worktree"` worker in `<spawn cwd>/.claude/worktrees/<name>`,
   * which matches its spawn. A start no Agent call announced (a Workflow's, say) runs
   * under its agent type's own rules and the session's record.
   */
  startWorker(session: string, agent: string, registered: string, cwd: string): void {
    const type = workerTypeName(registered);
    this.pruneSpawns();
    const waiting = [...this.spawns].filter(
      ([key, value]) => JSON.parse(key)[0] === session && value.type === type,
    );
    const [key, spawn] =
      waiting.find(
        ([, value]) => value.cwd === cwd || isClaudeWorktreeOf(value.cwd, cwd, this.platform),
      ) ??
      waiting[0] ??
      [];
    if (key) {
      this.spawns.delete(key);
    }
    this.recordWorker(session, agent, { ...(spawn ?? this.catalogs.get(cwd)?.[type]), cwd });
  }

  authorizeModCompaction(session: string, agent?: string): void {
    const current = this.resolveHarness(session, agent);
    const key = JSON.stringify([session, agent ?? 'main']);
    const id = randomUUID();
    if (!agent) {
      remember(this.compactions, key, { id });
      return;
    }
    const previous = this.compactions.get(key)?.previous ?? current;
    remember(this.compactions, key, { id, previous });
    this.recordWorker(session, agent, { ...current, tools: [], compaction: id });
  }

  /** Arm a tool-free boundary when SessionStart restored no prompt snapshot. */
  authorizeRestoredModCompaction(session: string): void {
    if (!this.sessions.has(session)) {
      this.recordSession(session, { permissionMode: 'default', tools: [], disallowedTools: [] });
    }
    this.authorizeModCompaction(session);
  }

  /** The compaction turn ended, successfully or not: the scope runs under its own policy again. */
  finishModCompaction(session: string, agent: string | undefined, id: string | undefined): void {
    const key = JSON.stringify([session, agent ?? 'main']);
    if (!id || this.compactions.get(key)?.id !== id) {
      return;
    }
    this.clearCompaction(key);
  }

  /** Disarm one scope's boundary without a result, for a cancelled or abandoned compaction. */
  cancelModCompaction(session: string, agent?: string): void {
    this.clearCompaction(JSON.stringify([session, agent ?? 'main']));
  }

  private clearCompaction(key: string): void {
    const saved = this.compactions.get(key);
    if (!saved) {
      return;
    }
    this.compactions.delete(key);
    const [session, agent] = JSON.parse(key) as [string, string];
    if (agent !== 'main' && saved.previous && this.workers.has(key)) {
      this.recordWorker(session, agent, saved.previous);
    }
  }

  forgetSession(session: string): void {
    this.sessions.delete(session);
    for (const entries of [this.workers, this.spawns, this.compactions]) {
      for (const key of entries.keys()) {
        if (JSON.parse(key)[0] === session) {
          entries.delete(key);
        }
      }
    }
  }

  /** Plan mode binds automatic review too. */
  planning(session: string, agent?: string): boolean {
    return this.resolve(session, agent).permissionMode === 'plan';
  }

  resolve(session: string, agent?: string): PermissionContext {
    const held = this.sessions.get(session) ?? { permissionMode: 'auto' };
    if (!agent) {
      const armed = this.compactions.get(JSON.stringify([session, 'main']));
      const context = structuredClone(held);
      return armed ? { ...context, tools: [], compaction: armed.id } : context;
    }
    const worker = this.workers.get(JSON.stringify([session, agent]));
    if (!worker) {
      // A worker the hooks have not reported inherits the session's record as it is.
      return structuredClone(held);
    }
    // These session modes override a worker's own, as in Claude; a planning session keeps
    // every worker, including one already running or resumed, in plan.
    const inherited = ['auto', 'acceptEdits', 'bypassPermissions', 'plan'].includes(
      held.permissionMode,
    );
    return mergePermissions(
      {
        ...worker,
        permissionMode: inherited
          ? held.permissionMode
          : permissionMode(worker.permissionMode ?? held.permissionMode),
      },
      held,
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

/**
 * A write refreshes the entry; at the cap the least recently written one makes room, so a
 * long-lived gateway never refuses new work for the sake of identities long idle.
 */
function remember<T>(entries: Map<string, T>, key: string, value: T): void {
  setBounded(entries, key, value, MAX_ENTRIES, 'lru');
}

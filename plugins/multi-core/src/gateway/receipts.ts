import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import type { GatewayEvent } from './server.ts';

const RECEIPT_SCHEMA_VERSION = 1;

type Usage = NonNullable<GatewayEvent['usage']> & {
  reasoning_tokens?: number;
  total_tokens?: number;
  model_calls?: number;
};
type InvocationEvent = GatewayEvent & {
  invocationId?: string;
  requestId?: string;
  usageMetadata?: { replayed?: boolean; source?: UsageSource };
};

export type ReceiptOutcome = 'completed' | 'failed' | 'cancelled';

export interface InvocationRef {
  session?: string;
  agentId?: string | null;
  invocationId?: string;
}

/**
 * Spend: what the requests consumed. A harness turn's standard usage fields
 * carry its last model call (its live context), so its consumption comes from
 * the `consumed_*` extension fields instead.
 */
interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens?: number;
  total_tokens?: number;
  model_calls?: number;
}

/** The live context the last response reported: its input side, as Claude Code reads it. */
interface ContextUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface UsageSnapshot {
  requests: number;
  totals: UsageTotals;
  /** The last response's context per provider. */
  contexts?: Partial<Record<GatewayEvent['route'], ContextUsage>>;
  byModel: Record<string, UsageTotals>;
  byEffort: Record<string, UsageTotals>;
  byEndpoint: Record<string, UsageTotals>;
  entries: UsageEntry[];
  truncated?: boolean;
}

type UsageSource = 'provider' | 'estimate' | 'mixed' | 'unavailable';

interface UsageEntry {
  provider: GatewayEvent['route'];
  requests: number;
  model?: string;
  effort?: string;
  endpoint?: string;
  source: UsageSource;
  usage: UsageTotals;
}

/** A durable worker invocation summary. It contains no prompts, tool inputs, or credentials. */
export interface WorkerUsageReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  id: string;
  kind: 'worker-usage';
  provenance: 'gateway';
  time: string;
  startedAt: string;
  outcome: ReceiptOutcome;
  session?: string;
  agentId: string | null;
  invocationId?: string;
  requests: number;
  incomplete?: boolean;
  usage: UsageTotals;
  /** The invocation's last response's context, beside what it consumed. */
  context?: ContextUsage;
  byModel: Record<string, UsageTotals>;
  byEffort: Record<string, UsageTotals>;
  byEndpoint: Record<string, UsageTotals>;
  entries: UsageEntry[];
  truncated?: boolean;
}

export interface ReceiptLedgerOptions {
  file?: string;
  append?: (file: string, line: string) => Promise<void>;
  now?: () => Date;
  onError?: (error: unknown) => void;
  maxInvocations?: number;
  writer?: (line: string) => Promise<void>;
  maxRecent?: number;
}

interface PendingInvocation {
  ref: InvocationRef;
  snapshot: UsageSnapshot;
  startedAt: string;
  context?: ContextUsage;
}

const emptyTotals = (): UsageTotals => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

function addUsage(target: UsageTotals, usage: Usage) {
  target.input_tokens += usage.input_tokens;
  target.output_tokens += usage.output_tokens;
  target.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  target.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  for (const key of ['reasoning_tokens', 'total_tokens', 'model_calls'] as const) {
    if (usage[key] !== undefined) {
      target[key] = (target[key] ?? 0) + usage[key];
    }
  }
}

function keyFor(ref: InvocationRef): string {
  return JSON.stringify([ref.session ?? null, ref.agentId ?? null]);
}

function copyTotals(totals: UsageTotals): UsageTotals {
  return { ...totals };
}

function copyBreakdown(breakdown: Record<string, UsageTotals>): Record<string, UsageTotals> {
  return Object.fromEntries(
    Object.entries(breakdown).map(([name, totals]) => [name, copyTotals(totals)]),
  );
}

function copySnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  return {
    ...snapshot,
    requests: snapshot.requests,
    totals: copyTotals(snapshot.totals),
    byModel: copyBreakdown(snapshot.byModel),
    byEffort: copyBreakdown(snapshot.byEffort),
    byEndpoint: copyBreakdown(snapshot.byEndpoint),
    entries: snapshot.entries.map((entry) => ({ ...entry, usage: copyTotals(entry.usage) })),
    ...(snapshot.contexts ? { contexts: structuredClone(snapshot.contexts) } : {}),
  };
}

function addBreakdown(
  breakdown: Record<string, UsageTotals>,
  name: string | undefined,
  usage: Usage,
) {
  if (!name) {
    return;
  }
  if (!Object.hasOwn(breakdown, name) && Object.keys(breakdown).length >= 256) {
    return;
  }
  const totals = Object.hasOwn(breakdown, name) ? breakdown[name] : emptyTotals();
  addUsage(totals, usage);
  breakdown[name] = totals;
}

function emptySnapshot(): UsageSnapshot {
  return {
    requests: 0,
    totals: emptyTotals(),
    byModel: {},
    byEffort: {},
    byEndpoint: {},
    entries: [],
  };
}

/** What one response consumed: the harness's turn sums when it reported them. */
function spend(event: InvocationEvent): Usage {
  const usage = event.usage as Usage;
  const metadata = event.usageMetadata;
  return {
    input_tokens: metadata?.consumed_input_tokens ?? usage.input_tokens,
    output_tokens: metadata?.consumed_output_tokens ?? usage.output_tokens,
    cache_read_input_tokens: metadata?.consumed_cache_read_tokens ?? usage.cache_read_input_tokens,
    cache_creation_input_tokens:
      metadata?.consumed_cache_creation_tokens ?? usage.cache_creation_input_tokens,
    reasoning_tokens: metadata?.reasoning_tokens,
    total_tokens: metadata?.total_tokens,
    model_calls: metadata?.model_calls,
  };
}

/** The live context one response reported, from its standard fields. */
function contextOf(event: InvocationEvent): ContextUsage {
  const usage = event.usage as Usage;
  return {
    input_tokens: usage.input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function aggregate(snapshot: UsageSnapshot, event: InvocationEvent) {
  const usage = spend(event);
  snapshot.contexts = { ...snapshot.contexts, [event.route]: contextOf(event) };
  snapshot.requests++;
  addUsage(snapshot.totals, usage);
  addBreakdown(snapshot.byModel, event.model, usage);
  addBreakdown(snapshot.byEffort, event.effort, usage);
  addBreakdown(snapshot.byEndpoint, event.endpoint, usage);
  const source = event.usageMetadata?.source ?? 'unavailable';
  const entry = snapshot.entries.find(
    (item) =>
      item.provider === event.route &&
      item.model === event.model &&
      item.effort === event.effort &&
      item.endpoint === event.endpoint &&
      item.source === source,
  );
  if (entry) {
    entry.requests++;
    addUsage(entry.usage, usage);
  } else if (snapshot.entries.length < 256) {
    const totals = emptyTotals();
    addUsage(totals, usage);
    snapshot.entries.push({
      provider: event.route,
      requests: 1,
      model: event.model,
      effort: event.effort,
      endpoint: event.endpoint,
      source,
      usage: totals,
    });
  } else {
    snapshot.truncated = true;
  }
}

/** One gateway owns this ledger; persisted lines never contain prompt or credential data. */
export class ReceiptLedger {
  private readonly pending = new Map<string, PendingInvocation>();
  private readonly sessions = new Map<string, UsageSnapshot>();
  private readonly completed: WorkerUsageReceipt[] = [];
  private readonly completedKeys = new Set<string>();
  private readonly seenRequests = new Set<string>();
  private readonly total = emptySnapshot();
  private readonly maxInvocations: number;
  private readonly maxRecent: number;
  private readonly writeLine: (line: string) => Promise<void>;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: ReceiptLedgerOptions = {}) {
    const append =
      options.append ?? ((file: string, line: string) => appendFile(file, line, { mode: 0o600 }));
    const file = options.file;
    this.writeLine = options.writer ?? (file ? (line) => append(file, line) : async () => {});
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => {});
    this.maxInvocations = Math.max(1, options.maxInvocations ?? 512);
    this.maxRecent = Math.max(1, options.maxRecent ?? 128);
  }

  start(ref: InvocationRef): void {
    if (this.pending.has(keyFor(ref))) {
      return;
    }
    if (this.pending.size >= this.maxInvocations) {
      const oldest = this.pending.values().next().value;
      if (oldest) {
        this.complete(oldest.ref, 'failed', true);
      }
    }
    this.pending.set(keyFor(ref), {
      ref,
      snapshot: emptySnapshot(),
      startedAt: this.now().toISOString(),
    });
  }

  observe(event: InvocationEvent): void {
    if (!event.usage || event.usageMetadata?.replayed) {
      return;
    }
    if (event.requestId && this.seenRequests.has(event.requestId)) {
      return;
    }
    if (event.requestId) {
      retain(this.seenRequests, event.requestId);
    }
    this.start(event);
    const pending = this.pending.get(keyFor(event));
    if (!pending) {
      return;
    }
    aggregate(pending.snapshot, event);
    pending.context = contextOf(event);
    aggregate(this.total, event);
    const session = event.session ?? '';
    if (!this.sessions.has(session)) {
      if (this.sessions.size >= 128) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) {
          this.sessions.delete(oldest);
        }
      }
      this.sessions.set(session, emptySnapshot());
    }
    const snapshot = this.sessions.get(session);
    if (snapshot) {
      aggregate(snapshot, event);
    }
  }

  complete(
    ref: InvocationRef,
    outcome: ReceiptOutcome,
    incomplete = false,
  ): WorkerUsageReceipt | undefined {
    const dedup = JSON.stringify([keyFor(ref), ref.invocationId]);
    if (ref.invocationId && this.completedKeys.has(dedup)) {
      return undefined;
    }
    const pending = this.pending.get(keyFor(ref));
    if (!pending) {
      return undefined;
    }
    this.pending.delete(keyFor(ref));
    if (ref.invocationId) {
      retain(this.completedKeys, dedup);
    }
    const snapshot = copySnapshot(pending.snapshot);
    const receipt: WorkerUsageReceipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      id: randomUUID(),
      kind: 'worker-usage',
      provenance: 'gateway',
      time: this.now().toISOString(),
      startedAt: pending.startedAt,
      outcome,
      session: ref.session,
      agentId: ref.agentId ?? null,
      invocationId: ref.invocationId,
      requests: snapshot.requests,
      incomplete: incomplete || outcome !== 'completed' || snapshot.truncated || undefined,
      usage: snapshot.totals,
      ...(pending.context ? { context: { ...pending.context } } : {}),
      byModel: snapshot.byModel,
      byEffort: snapshot.byEffort,
      byEndpoint: snapshot.byEndpoint,
      entries: snapshot.entries,
    };
    this.completed.push(receipt);
    if (this.completed.length > this.maxRecent) {
      this.completed.shift();
    }
    const line = `${JSON.stringify(receipt)}\n`;
    this.queue = this.queue
      .then(() => this.writeLine(line))
      .catch((error: unknown) => {
        this.onError(error);
      });
    return structuredClone(receipt);
  }

  finishAll(outcome: ReceiptOutcome = 'cancelled'): void {
    for (const pending of [...this.pending.values()]) {
      this.complete(pending.ref, outcome, true);
    }
  }

  snapshot(session?: string): UsageSnapshot {
    return copySnapshot(
      session === undefined ? this.total : (this.sessions.get(session) ?? emptySnapshot()),
    );
  }

  recent(session: string): WorkerUsageReceipt[] {
    return structuredClone(this.completed.filter((receipt) => receipt.session === session));
  }

  drain(): Promise<void> {
    return this.queue;
  }
}

function retain(set: Set<string>, key: string) {
  set.add(key);
  if (set.size > 8192) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) {
      set.delete(oldest);
    }
  }
}

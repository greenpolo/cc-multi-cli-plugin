import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic-write.ts';
import type { HarnessEvent } from './harness-exchange.ts';
import type { MessagesResponse } from './messages.ts';
import { lockStateFile } from './state-lock.ts';

/**
 * Another run owns this agent. A prompt that arrives during a run was composed
 * before that run answered, so resuming with it would forward the running turn a
 * second time: a blind rerun of a paid turn. It is refused, never queued, and a
 * retryable status turned one such conflict into ten attempts in a live session.
 */
export class HarnessBusyError extends Error {}

/** The half of a persisted native session every harness shares. */
export type HarnessSessionBase = {
  provider: string;
  identity: string;
  interrupted: boolean;
  response?: MessagesResponse;
  replay?: { key: string; events: HarnessEvent[] };
  policyIdentity?: string;
};

/** Live state that is never persisted. */
export type HarnessSessionRuntime = {
  file: string;
  busy: boolean;
  release: () => Promise<void>;
  unlock?: Promise<void>;
};

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Whether one persisted content block may be replayed. The default accepts text
 * only; a provider whose replies carry other block kinds supplies its own.
 */
export type ContentBlockCheck = (block: Record<string, unknown>) => boolean;

export const textContentBlock: ContentBlockCheck = (block) =>
  block.type === 'text' && typeof block.text === 'string';

/**
 * The only way to reach a native session record. It owns the lock file, the busy
 * flag and the load gate, so a provider cannot re-add queuing without bypassing
 * it: both entry points refuse a busy identity with `HarnessBusyError`.
 */
export class HarnessSessionStore<S extends HarnessSessionBase> {
  private readonly provider: string;
  /** The provider's display name, used only in messages the caller reads. */
  private readonly tag: string;
  private readonly validContentBlock: ContentBlockCheck;
  private readonly stateDirectory: string;
  private readonly platform: NodeJS.Platform;
  private readonly version: number;
  private readonly fresh: (identity: string) => S;
  private readonly validate: (saved: Partial<S>) => boolean;
  private readonly transient: readonly string[];
  private readonly records = new Map<string, S & HarnessSessionRuntime>();
  private readonly creating = new Set<string>();
  private readonly loading = new Set<string>();

  constructor(options: {
    provider: string;
    /** Display name for messages; defaults to the on-disk `provider` discriminator. */
    tag?: string;
    stateDirectory: string;
    platform: NodeJS.Platform;
    version: number;
    fresh: (identity: string) => S;
    validate: (saved: Partial<S>) => boolean;
    /** Extra live-only keys a provider hangs on its record; never persisted. */
    transient?: readonly string[];
    /** Accepts the content blocks this provider's replies may carry on replay. */
    validContentBlock?: ContentBlockCheck;
  }) {
    this.provider = options.provider;
    this.tag = options.tag ?? options.provider;
    this.validContentBlock = options.validContentBlock ?? textContentBlock;
    this.stateDirectory = options.stateDirectory;
    this.platform = options.platform;
    this.version = options.version;
    this.fresh = options.fresh;
    this.validate = options.validate;
    this.transient = options.transient ?? [];
  }

  /** One turn at a time per agent: take the record and mark it busy, or refuse. */
  async acquire(identity: string): Promise<S & HarnessSessionRuntime> {
    const current = this.records.get(identity);
    if (current?.busy || this.creating.has(identity)) {
      throw new HarnessBusyError(
        `A different request is already running for this ${this.tag} agent`,
      );
    }
    this.creating.add(identity);
    try {
      const session = current ?? (await this.load(identity));
      session.busy = true;
      return session;
    } finally {
      this.creating.delete(identity);
    }
  }

  /** Read the record without taking the turn, for replay decisions. */
  async loadOnly(identity: string): Promise<S & HarnessSessionRuntime> {
    const current = this.records.get(identity);
    if (current) {
      return current;
    }
    if (this.loading.has(identity)) {
      throw new HarnessBusyError(`A different request is already loading this ${this.tag} agent`);
    }
    this.loading.add(identity);
    try {
      return await this.load(identity);
    } finally {
      this.loading.delete(identity);
    }
  }

  release(session: S & HarnessSessionRuntime): void {
    session.busy = false;
  }

  save(session: S & HarnessSessionRuntime): Promise<void> {
    const { file: _file, busy: _busy, release: _release, unlock: _unlock, ...saved } = session;
    const persisted = Object.fromEntries(
      Object.entries(saved).filter(([key]) => !this.transient.includes(key)),
    );
    return atomicJson(session.file, { ...persisted, provider: this.provider }, this.platform);
  }

  /**
   * Drop a cached record without touching its file. The caller owns the lock it
   * took: release it first to hand the identity on, or keep it to hold the scope.
   */
  forget(identity: string): void {
    this.records.delete(identity);
  }

  releaseLock(session: S & HarnessSessionRuntime): Promise<void> {
    session.unlock ??= session.release();
    return session.unlock;
  }

  async closeAll(): Promise<void> {
    for (const session of this.records.values()) {
      await this.releaseLock(session);
    }
    this.records.clear();
  }

  sessions(): IterableIterator<S & HarnessSessionRuntime> {
    return this.records.values();
  }

  /** The record's file, for the provider reads that must not take the lock. */
  sessionFile(identity: string): string {
    return path.join(this.stateDirectory, `${digest(identity)}.session.json`);
  }

  private async load(identity: string): Promise<S & HarnessSessionRuntime> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const file = this.sessionFile(identity);
    const release = await lockStateFile(`${file}.lock`);
    try {
      const saved = await this.read(file);
      const session: S & HarnessSessionRuntime = {
        ...(saved ?? this.fresh(identity)),
        file,
        busy: false,
        release,
      };
      this.records.set(identity, session);
      return session;
    } catch (error) {
      await release();
      throw error;
    }
  }

  private async read(file: string): Promise<S | undefined> {
    const saved = (await readJson(file)) as (Partial<S> & { version?: unknown }) | undefined;
    if (saved === undefined) {
      return undefined;
    }
    if (saved.version !== this.version) {
      // The native session is never deleted; an unknown record is ignored and a
      // fresh session starts rather than refusing to load.
      return undefined;
    }
    if (
      saved.provider !== this.provider ||
      typeof saved.identity !== 'string' ||
      typeof saved.interrupted !== 'boolean' ||
      (saved.policyIdentity !== undefined && !isHash(saved.policyIdentity)) ||
      !validSavedResponse(saved, this.validContentBlock) ||
      !this.validate(saved)
    ) {
      throw new Error(`${this.tag} session has invalid state; refusing native replay`);
    }
    return saved as S;
  }
}

function validSavedResponse(
  saved: Partial<HarnessSessionBase>,
  validContentBlock: ContentBlockCheck,
): boolean {
  if (saved.response === undefined && saved.replay === undefined) {
    return true;
  }
  return validMessagesResponse(saved.response, validContentBlock) && validReplay(saved.replay);
}

export async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function atomicJson(
  file: string,
  value: unknown,
  platform: NodeJS.Platform,
): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(value), { mode: 0o600, platform });
}

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function optionalCount(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
}

export function validMessagesResponse(
  value: unknown,
  validContentBlock: ContentBlockCheck = textContentBlock,
): value is MessagesResponse {
  if (!isRecord(value)) {
    return false;
  }
  const response = value as Partial<MessagesResponse>;
  return (
    typeof response.id === 'string' &&
    response.type === 'message' &&
    response.role === 'assistant' &&
    typeof response.model === 'string' &&
    Array.isArray(response.content) &&
    response.content.every((block) => isRecord(block) && validContentBlock(block)) &&
    (response.stop_reason === null || response.stop_reason === 'end_turn') &&
    (response.stop_sequence === null || typeof response.stop_sequence === 'string') &&
    validResponseUsage(response.usage)
  );
}

function validResponseUsage(value: unknown): value is MessagesResponse['usage'] {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Number.isSafeInteger(value.input_tokens) &&
    Number(value.input_tokens) >= 0 &&
    Number.isSafeInteger(value.output_tokens) &&
    Number(value.output_tokens) >= 0 &&
    optionalCount(value.cache_read_input_tokens) &&
    optionalCount(value.cache_creation_input_tokens)
  );
}

export function validPersistedResponse(
  value: unknown,
  validContentBlock: ContentBlockCheck = textContentBlock,
): value is { response: MessagesResponse; events: HarnessEvent[] } {
  if (!isRecord(value)) {
    return false;
  }
  return validMessagesResponse(value.response, validContentBlock) && validEvents(value.events);
}

export function validReplay(value: unknown): value is { key: string; events: HarnessEvent[] } {
  if (!isRecord(value)) {
    return false;
  }
  return isHash(value.key) && validEvents(value.events);
}

function validEvents(value: unknown): value is HarnessEvent[] {
  return Array.isArray(value) && value.every(validEvent);
}

function validEvent(value: unknown): value is HarnessEvent {
  if (!Array.isArray(value) || value.length !== 2) {
    return false;
  }
  const [name, body] = value;
  return (
    typeof name === 'string' &&
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
      'ping',
      'error',
    ].includes(name) &&
    isRecord(body)
  );
}

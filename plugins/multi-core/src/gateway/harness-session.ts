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
export type HarnessSession<S extends HarnessSessionBase, R extends object = object> = {
  saved: S;
  runtime: R;
  readonly identity: string;
  readonly file: string;
  readonly busy: boolean;
};

export type HarnessTurnLease<S extends HarnessSessionBase, R extends object = object> = {
  session: HarnessSession<S, R>;
  release: () => Promise<void>;
};

type OwnedSession = {
  busy: boolean;
  releases: Array<() => Promise<void>>;
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
 * it: lease acquisition refuses a busy identity with `HarnessBusyError`.
 */
export class HarnessSessionStore<S extends HarnessSessionBase, R extends object = object> {
  private readonly provider: string;
  /** The provider's display name, used only in messages the caller reads. */
  private readonly tag: string;
  private readonly validContentBlock: ContentBlockCheck;
  private readonly stateDirectory: string;
  private readonly platform: NodeJS.Platform;
  private readonly version: number;
  private readonly fresh: (identity: string) => S;
  private readonly validate: (saved: Partial<S>) => boolean;
  private readonly freshRuntime: (saved: S) => R;
  private readonly aliasFiles: (identity: string) => string[];
  private readonly restore?: (options: {
    identity: string;
    files: readonly string[];
    read: (file: string) => Promise<unknown>;
  }) => Promise<{ saved: unknown; migrated?: boolean }>;
  private readonly records = new Map<string, HarnessSession<S, R>>();
  private readonly owned = new WeakMap<HarnessSession<S, R>, OwnedSession>();
  private readonly loading = new Set<string>();
  private closing = false;

  constructor(options: {
    provider: string;
    /** Display name for messages; defaults to the on-disk `provider` discriminator. */
    tag?: string;
    stateDirectory: string;
    platform: NodeJS.Platform;
    version: number;
    fresh: (identity: string) => S;
    validate: (saved: Partial<S>) => boolean;
    runtime: (saved: S) => R;
    /** Additional record aliases whose locks are held for the session lifetime. */
    aliasFiles?: (identity: string) => string[];
    /** Provider-owned selection or migration across canonical and alias records. */
    restore?: (options: {
      identity: string;
      files: readonly string[];
      read: (file: string) => Promise<unknown>;
    }) => Promise<{ saved: unknown; migrated?: boolean }>;
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
    this.freshRuntime = options.runtime;
    this.aliasFiles = options.aliasFiles ?? (() => []);
    this.restore = options.restore;
  }

  /** One turn at a time per agent: take the record and mark it busy, or refuse. */
  async acquireLease(identity: string): Promise<HarnessTurnLease<S, R>> {
    this.assertOpen();
    const current = this.records.get(identity);
    if (current?.busy || this.loading.has(identity)) {
      throw new HarnessBusyError(
        `A different request is already running for this ${this.tag} agent`,
      );
    }
    this.loading.add(identity);
    try {
      const session = current ?? (await this.load(identity));
      this.assertOpen();
      const owned = this.mustOwn(session);
      owned.busy = true;
      let released = false;
      return {
        session,
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          owned.busy = false;
          if (this.closing) {
            await this.releaseLock(session);
            this.records.delete(identity);
          }
        },
      };
    } finally {
      this.loading.delete(identity);
    }
  }

  async save(session: HarnessSession<S, R>): Promise<void> {
    const owned = this.mustOwn(session);
    if (owned.unlock !== undefined) {
      throw new Error(`${this.tag} session lock has been released`);
    }
    await atomicJson(session.file, { ...session.saved, provider: this.provider }, this.platform);
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    for (const session of this.records.values()) {
      if (!session.busy) {
        await this.releaseLock(session);
        this.records.delete(session.identity);
      }
    }
  }

  sessions(): IterableIterator<HarnessSession<S, R>> {
    return this.records.values();
  }

  /** Drop an idle attachment without deleting its durable native identity. */
  async evictIdle(session: HarnessSession<S, R>): Promise<boolean> {
    if (session.busy || this.loading.has(session.identity)) {
      return false;
    }
    if (this.records.get(session.identity) !== session) {
      return false;
    }
    this.loading.add(session.identity);
    this.records.delete(session.identity);
    try {
      await this.releaseLock(session);
      return true;
    } finally {
      this.loading.delete(session.identity);
    }
  }

  /** The record's file, for the provider reads that must not take the lock. */
  sessionFile(identity: string): string {
    return path.join(this.stateDirectory, `${digest(identity)}.session.json`);
  }

  private async load(identity: string): Promise<HarnessSession<S, R>> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const file = this.sessionFile(identity);
    const files = [
      file,
      ...this.aliasFiles(identity).map((item) => resolveStateFile(this.stateDirectory, item)),
    ];
    const uniqueFiles = [...new Set(files)];
    const releases: Array<() => Promise<void>> = [];
    try {
      for (const locked of [...uniqueFiles].sort()) {
        releases.push(await lockStateFile(`${locked}.lock`, { platform: this.platform }));
      }
      const restored = this.restore
        ? await this.restore({ identity, files: uniqueFiles, read: readJson })
        : { saved: await readJson(file) };
      this.assertOpen();
      const selected = this.validateSaved(restored.saved, identity);
      const saved = selected ?? this.fresh(identity);
      const owned: OwnedSession = { busy: false, releases };
      const session: HarnessSession<S, R> = {
        saved,
        runtime: this.freshRuntime(saved),
        identity,
        file,
        get busy() {
          return owned.busy;
        },
      };
      this.owned.set(session, owned);
      if (restored.migrated === true && selected !== undefined) {
        await this.save(session);
      }
      if (this.closing) {
        throw new Error(`${this.tag} session store is closed`);
      }
      this.records.set(identity, session);
      return session;
    } catch (error) {
      await Promise.allSettled(releases.map((release) => release()));
      throw error;
    }
  }

  private validateSaved(value: unknown, identity: string): S | undefined {
    if (value !== undefined && !isRecord(value)) {
      throw new Error(`${this.tag} session has invalid state; refusing native replay`);
    }
    const saved = value as (Partial<S> & { version?: unknown }) | undefined;
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
      saved.identity !== identity ||
      typeof saved.interrupted !== 'boolean' ||
      (saved.policyIdentity !== undefined && !isHash(saved.policyIdentity)) ||
      !validSavedResponse(saved, this.validContentBlock) ||
      !this.validate(saved)
    ) {
      throw new Error(`${this.tag} session has invalid state; refusing native replay`);
    }
    return saved as S;
  }

  private mustOwn(session: HarnessSession<S, R>): OwnedSession {
    const owned = this.owned.get(session);
    if (!owned) {
      throw new Error(`${this.tag} session is not owned by this store`);
    }
    return owned;
  }

  private releaseLock(session: HarnessSession<S, R>): Promise<void> {
    const owned = this.mustOwn(session);
    owned.unlock ??= Promise.all(owned.releases.map((release) => release())).then(() => undefined);
    return owned.unlock;
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new Error(`${this.tag} session store is closed`);
    }
  }
}

function resolveStateFile(directory: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(directory, file);
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

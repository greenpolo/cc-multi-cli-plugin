import path from 'node:path';
import { type ContentBlockCheck, readJson, validPersistedResponse } from './harness-session.ts';
import type { Emit, MessagesResponse, StreamEventBody, StreamEventName } from './messages.ts';

/** One recorded Anthropic stream event, replayable verbatim. */
export type HarnessEvent = [StreamEventName, StreamEventBody];

/**
 * One in-flight native turn. `meta` carries provider-owned run facts (Cursor's
 * `mayHaveRun`/`committed`/row observer); the registry itself never reads it.
 */
export type HarnessExchange<M extends object = Record<string, unknown>> = {
  result: Promise<MessagesResponse>;
  controller: AbortController;
  events: HarnessEvent[];
  listeners: Set<Emit>;
  observers: number;
  settled: boolean;
  meta: M;
};

/**
 * Identical requests share one native run. A second caller observes the running
 * exchange instead of starting a second paid turn.
 */
export class ExchangeRegistry<M extends object = Record<string, unknown>> {
  private readonly provider: string;
  private readonly createMeta: () => M;
  private readonly exchanges = new Map<string, HarnessExchange<M>>();

  constructor(options: { provider: string; createMeta: () => M }) {
    this.provider = options.provider;
    this.createMeta = options.createMeta;
  }

  start(
    key: string,
    run: (exchange: HarnessExchange<M>, emit: Emit) => Promise<MessagesResponse>,
    options: { retain?: (exchange: HarnessExchange<M>) => boolean } = {},
  ): HarnessExchange<M> {
    const events: HarnessEvent[] = [];
    const listeners = new Set<Emit>();
    const forward: Emit = (name, value) => {
      events.push([name, structuredClone(value)]);
      for (const listener of listeners) {
        listener(name, value);
      }
    };
    const exchange: HarnessExchange<M> = {
      controller: new AbortController(),
      events,
      listeners,
      observers: 0,
      settled: false,
      meta: this.createMeta(),
      result: Promise.resolve().then(() => run(exchange, forward)),
    };
    const settle = () => {
      exchange.settled = true;
      // A retained exchange stays addressable so its uncertainty is reported to
      // the next identical request instead of being rerun.
      if (options.retain?.(exchange) === true) {
        return;
      }
      if (this.exchanges.get(key) === exchange) {
        this.exchanges.delete(key);
      }
    };
    void exchange.result.then(settle, settle);
    this.exchanges.set(key, exchange);
    return exchange;
  }

  get(key: string): HarnessExchange<M> | undefined {
    return this.exchanges.get(key);
  }

  get size(): number {
    return this.exchanges.size;
  }

  /**
   * Make room for a new request by dropping one finished exchange. A running
   * exchange is never dropped, so a second caller can still join it instead of
   * starting a second paid turn.
   */
  evictSettled(): boolean {
    for (const [key, exchange] of this.exchanges) {
      if (exchange.settled) {
        this.exchanges.delete(key);
        return true;
      }
    }
    return false;
  }

  all(): HarnessExchange<M>[] {
    return [...this.exchanges.values()];
  }

  /**
   * Follow a running exchange: replay what it already emitted, stream the rest,
   * and cancel the native run once its last observer leaves.
   */
  async observe(
    exchange: HarnessExchange<M>,
    signal: AbortSignal,
    emit?: Emit,
  ): Promise<MessagesResponse> {
    exchange.observers++;
    const aborted = Promise.withResolvers<never>();
    void aborted.promise.catch(() => {});
    const cancel = () => aborted.reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (emit) {
        exchange.listeners.add(emit);
        for (const event of exchange.events) {
          emit(...event);
        }
      }
      signal.throwIfAborted();
      return await Promise.race([exchange.result, aborted.promise]);
    } finally {
      signal.removeEventListener('abort', cancel);
      if (emit) {
        exchange.listeners.delete(emit);
      }
      exchange.observers--;
      if (!exchange.observers && !exchange.settled) {
        exchange.controller.abort(new Error(`All ${this.provider} observers disconnected`));
      }
    }
  }
}

/**
 * A completed identical request is replayed from the session record or from its
 * own response file; a native turn is never repeated to reproduce an answer.
 */
export async function replayPersisted(args: {
  stateDirectory: string;
  key: string;
  saved?: { replay?: { key: string; events: HarnessEvent[] }; response?: MessagesResponse };
  emit: Emit;
  provider: string;
  /** Accepts the content blocks this provider's replies may carry; text-only by default. */
  validContentBlock?: ContentBlockCheck;
}): Promise<MessagesResponse | undefined> {
  const { saved, key } = args;
  const persisted =
    saved?.replay?.key === key
      ? { response: saved.response, events: saved.replay.events }
      : await readJson(path.join(args.stateDirectory, `${key}.response.json`));
  if (persisted === undefined) {
    return undefined;
  }
  if (!validPersistedResponse(persisted, args.validContentBlock)) {
    throw new Error(`Invalid persisted ${args.provider} response`);
  }
  for (const event of persisted.events) {
    args.emit(...event);
  }
  return {
    ...persisted.response,
    multi_usage: persisted.response.multi_usage
      ? { ...persisted.response.multi_usage, replayed: true }
      : { source: 'unavailable' as const, replayed: true },
  };
}

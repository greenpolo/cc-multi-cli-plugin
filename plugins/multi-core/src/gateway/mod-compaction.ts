import { createHash, randomUUID } from 'node:crypto';
import type { PermissionContext } from './mode-hook.ts';

type Transcript = Record<string, unknown>[];
type Input = {
  session: string;
  agent?: string;
  generation: number;
  messages: Transcript;
  instructions?: string;
};
type Job = Input & {
  id: string;
  digest: string;
  expiresAt: number;
  controller: AbortController;
  state: 'prepared' | 'pending' | 'ready' | 'failed';
  summary?: string;
};
export type SummaryRequest = Input & {
  context: PermissionContext;
  signal: AbortSignal;
  id: string;
};

/** A summary can replace only the identical leading transcript, never native state. */
export class ModCompactions {
  private readonly jobs = new Map<string, Job>();
  private readonly summarize: (request: SummaryRequest) => Promise<string>;

  constructor(summarize: (request: SummaryRequest) => Promise<string>) {
    this.summarize = summarize;
  }

  prepare(input: Input) {
    this.prune();
    const key = scope(input);
    this.remove(key);
    const job: Job = {
      ...structuredClone(input),
      id: randomUUID(),
      digest: digest(input.messages, input.instructions),
      expiresAt: Date.now() + 120000,
      controller: new AbortController(),
      state: 'prepared',
    };
    this.jobs.set(key, job);
    return {
      accepted: true,
      precomputeId: job.id,
      messageDigest: job.digest,
      expiresAt: job.expiresAt,
    };
  }

  run(
    input: Pick<Input, 'session' | 'agent' | 'generation'>,
    id: string,
    context: PermissionContext,
  ) {
    const job = this.job(input, id);
    if (job.state !== 'prepared') {
      return { accepted: true, status: job.state };
    }
    job.state = 'pending';
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(120000)]);
    void this.summarize({
      ...job,
      signal,
      context: { ...context, tools: [], compaction: job.id },
    }).then(
      (summary) => {
        if (
          !signal.aborted &&
          this.jobs.get(scope(input)) === job &&
          summary &&
          summary.length <= 16000
        ) {
          job.summary = summary;
          job.state = 'ready';
        } else {
          job.state = 'failed';
        }
      },
      () => {
        job.state = 'failed';
      },
    );
    return { accepted: true, status: job.state };
  }

  authorize(input: Input) {
    this.prune();
    const job = this.jobs.get(scope(input));
    if (!job || job.generation !== input.generation || job.state !== 'ready') {
      return { allow: true };
    }
    const prefix = input.messages.slice(0, job.messages.length);
    if (digest(prefix, input.instructions) !== job.digest) {
      this.remove(scope(input));
      return { allow: true };
    }
    const messages = [
      { role: 'user', text: `Conversation summary:\n${job.summary}`, toolUses: [] },
      ...input.messages.slice(job.messages.length),
    ];
    this.remove(scope(input));
    return { allow: true, messageDigest: job.digest, messages };
  }

  cancelScope(session: string, agent?: string) {
    this.remove(scope({ session, agent }));
  }

  cancel(session: string) {
    for (const [key, job] of this.jobs) {
      if (job.session === session) {
        this.remove(key);
      }
    }
  }

  private job(input: Pick<Input, 'session' | 'agent' | 'generation'>, id: string) {
    this.prune();
    const job = this.jobs.get(scope(input));
    if (!job || job.id !== id || job.generation !== input.generation) {
      throw new Error('Compaction generation is unknown or stale');
    }
    return job;
  }

  private remove(key: string) {
    this.jobs.get(key)?.controller.abort();
    this.jobs.delete(key);
  }

  private prune() {
    for (const [key, job] of this.jobs) {
      if (job.expiresAt <= Date.now()) {
        this.remove(key);
      }
    }
  }
}

function scope(input: { session: string; agent?: string }) {
  return JSON.stringify([input.session, input.agent ?? 'main']);
}
function digest(messages: Transcript, instructions?: string) {
  return createHash('sha256')
    .update(JSON.stringify([messages, instructions ?? '']))
    .digest('hex');
}

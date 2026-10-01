import { randomUUID } from 'node:crypto';
import type { WorkerPermissions } from './agent-definitions.ts';

export type PreparedPolicy = {
  cwd: string;
  workers: Record<string, WorkerPermissions>;
  restrictions: WorkerPermissions;
};
type Job = {
  cwd: string;
  createdAt: number;
  /** Resolves when discovery ends, ready or failed, so a waiting hook is released at once. */
  settled: Promise<void>;
  consumed: boolean;
  generation: string;
  status: 'pending' | 'ready' | 'failed';
  policy?: PreparedPolicy;
  error?: string;
};

/** An unconsumed job is reused for this long; settings read after that are read again. */
const JOB_TTL_MS = 60_000;
const MAX_SESSIONS = 128;
/** The longest a hook's long poll holds its reply; the hook sends one request, not a loop. */
export const POLICY_WAIT_MS = 8000;

/** File discovery runs detached from the bounded hook requests. */
export class ModPolicies {
  private inFlight = 0;
  private readonly jobs = new Map<string, Job>();
  private readonly load: (cwd: string) => Promise<PreparedPolicy>;
  private readonly now: () => number;

  constructor(load: (cwd: string) => Promise<PreparedPolicy>, now: () => number = Date.now) {
    this.load = load;
    this.now = now;
  }

  begin(session: string, cwd: string) {
    const existing = this.jobs.get(session);
    if (
      existing &&
      existing.cwd === cwd &&
      !existing.consumed &&
      existing.status !== 'failed' &&
      this.now() - existing.createdAt < JOB_TTL_MS
    ) {
      return { generation: existing.generation, status: existing.status };
    }
    if (this.inFlight >= 64) {
      throw new Error('Policy discovery capacity reached');
    }
    if (!this.jobs.has(session) && this.jobs.size >= MAX_SESSIONS) {
      this.evictIdle();
    }
    let settle = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const job: Job = {
      cwd,
      createdAt: this.now(),
      settled,
      consumed: false,
      generation: randomUUID(),
      status: 'pending',
    };
    // Re-inserted last: the map's order is the recency eviction reads.
    this.jobs.delete(session);
    this.jobs.set(session, job);
    this.inFlight++;
    void this.load(cwd).then(
      (policy) => {
        this.inFlight--;
        if (this.jobs.get(session) === job) {
          job.policy = structuredClone(policy);
          job.status = 'ready';
        }
        settle();
      },
      (error: unknown) => {
        this.inFlight--;
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Policy discovery failed';
        settle();
      },
    );
    return { generation: job.generation, status: job.status };
  }

  /** Makes room by dropping the least recently begun session whose discovery has ended. */
  private evictIdle() {
    for (const [session, job] of this.jobs) {
      if (job.status !== 'pending') {
        this.jobs.delete(session);
        return;
      }
    }
    throw new Error('Policy session capacity reached; every session is still discovering');
  }

  /**
   * The status once discovery has ended, or still pending after `timeoutMs`: a hook asks
   * once and the gateway holds the reply, so the wait costs the hook no polling loop.
   */
  async wait(session: string, generation: string, timeoutMs = POLICY_WAIT_MS) {
    const job = this.jobs.get(session);
    if (job?.generation === generation && job.status === 'pending') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      try {
        await Promise.race([job.settled, expired]);
      } finally {
        clearTimeout(timer);
      }
    }
    return this.status(session, generation);
  }

  status(session: string, generation: string) {
    const job = this.jobs.get(session);
    if (!job || job.generation !== generation) {
      throw new Error('Policy generation is unavailable or stale');
    }
    return { generation, status: job.status, error: job.error };
  }

  consume(session: string, generation: string, cwd: string): PreparedPolicy {
    this.status(session, generation);
    const job = this.jobs.get(session);
    const policy = job?.policy;
    if (!job || !policy || policy.cwd !== cwd) {
      throw new Error('Policy generation is not ready for this workspace');
    }
    job.consumed = true;
    return structuredClone(policy);
  }

  forget(session: string) {
    this.jobs.delete(session);
  }
}

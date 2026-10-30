// Shared across reviewer instances, sessions and gateways in this process.
const limit = 4;
let active = 0;
const waiting = new Set<() => void>();

export async function withReviewSlot<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  await acquire(signal);
  try {
    signal.throwIfAborted();
    return await run();
  } finally {
    release();
  }
}

async function acquire(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (active < limit) {
    active++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const grant = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      waiting.delete(grant);
      reject(signal.reason);
    };
    waiting.add(grant);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function release(): void {
  const next = waiting.values().next().value;
  if (next) {
    waiting.delete(next);
    next();
  } else {
    active--;
  }
}

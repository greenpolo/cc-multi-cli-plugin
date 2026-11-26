import type { HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code';

/**
 * A Claude desktop app session: the app starts Claude Code itself, so no launcher starts
 * the gateway. `register.ts` starts `src/serve.ts` with `$.process.spawn` and reads its
 * handshake (`src/launch/desktop.ts`) here. The child lives as long as its stream is read:
 * leaving the loop, a hot reload or the session's end kills it, so this module keeps the
 * stream and nothing else.
 */
export type Handshake = {
  env: Record<string, string>;
  workers: Array<{
    name: string;
    description: string;
    prompt: string;
    model: string;
    effort?: string;
  }>;
  frontDoor: boolean;
  notice?: string;
};

type Served = HookStream<ProcessSpawnChunk, ProcessSpawnResult>;

/** The gateway is up within this; one model listing can be slow, the gateway is not. */
export const HANDSHAKE_MS = 8000;
const maxHandshake = 256 * 1024;
const maxReason = 240;

let served: Served | undefined;

/** Ends this session's gateway, if this module started one. */
export function stopServed(): void {
  const stream = served;
  served = undefined;
  void stream?.return(undefined as unknown as ProcessSpawnResult).catch(() => undefined);
}

/** What the child has written so far: the handshake line on stdout, the tail of stderr. */
class Output {
  stdout = '';
  stderr = '';
  line?: string;

  /** Takes one piece; true once the handshake line is complete or can no longer be. */
  take(pipe: 'stdout' | 'stderr', text: string): boolean {
    if (pipe === 'stderr') {
      this.stderr = (this.stderr + text).slice(-maxReason);
      return false;
    }
    this.stdout += text;
    const end = this.stdout.indexOf('\n');
    if (end >= 0) {
      this.line = this.stdout.slice(0, end);
    }
    return end >= 0 || this.stdout.length > maxHandshake;
  }

  /** The handshake, or why there is none. */
  answer(): Handshake {
    if (this.line === undefined) {
      throw new Error(this.stderr.trim() || 'the gateway ended before it started');
    }
    return parseHandshake(this.line);
  }
}

/**
 * Reads the handshake line, then keeps draining the child's output (it blocks once a
 * megabyte waits unread) until it ends. Resolves with the handshake, or rejects with the
 * child's own reason when it ends or writes something else first.
 */
export function readHandshake(stream: Served, log: (text: string) => void): Promise<Handshake> {
  stopServed();
  served = stream;
  const output = new Output();
  let answer: ((complete: boolean) => void) | undefined;
  const answered = new Promise<boolean>((resolve) => {
    answer = resolve;
  });
  void drain(stream, output, log, () => answer?.(true)).then(() => answer?.(false));
  return answered.then(() => output.answer());
}

/** After the handshake, what the gateway writes on stderr goes to the debug log. */
async function drain(
  stream: Served,
  output: Output,
  log: (text: string) => void,
  complete: () => void,
) {
  let done = false;
  try {
    for await (const { stream: pipe, text } of stream) {
      if (done && pipe === 'stderr') {
        log(text.trimEnd());
      } else if (!done && output.take(pipe, text)) {
        done = true;
        complete();
      }
    }
  } catch (error) {
    output.stderr ||= error instanceof Error ? error.message : String(error);
  }
  if (served === stream) {
    served = undefined;
  }
}

function parseHandshake(line: string): Handshake {
  const value: unknown = JSON.parse(line);
  const shaped = value as Partial<Handshake> | null;
  if (
    !shaped ||
    typeof shaped !== 'object' ||
    !shaped.env ||
    typeof shaped.env !== 'object' ||
    !Array.isArray(shaped.workers)
  ) {
    throw new Error('the gateway wrote a malformed handshake');
  }
  return shaped as Handshake;
}

/** The Node setup recorded (`~/.local/share/multi-cli/state.json`), else `node` on PATH. */
export function nodeOf(state: string | undefined): string {
  try {
    const node: unknown = state ? JSON.parse(state).node : undefined;
    return typeof node === 'string' && node ? node : 'node';
  } catch {
    return 'node';
  }
}

/** A one-line notice, bounded. */
export function noticeText(reason: string): string {
  const line = reason.replace(/\s+/g, ' ').trim();
  return line.length > maxReason ? `${line.slice(0, maxReason - 1)}…` : line;
}

import { once } from 'node:events';
import type { ServerResponse } from 'node:http';

interface Tool {
  id: string;
  name: string;
  input: unknown;
}

const MAX_BYTES = 8 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Observe provider output for attribution, never for permission grants. */
export class ToolObserver {
  private blocks = new Map<number, Tool & { json: string }>();
  private remember: (tool: Tool) => void;

  constructor(remember: (tool: Tool) => void) {
    this.remember = remember;
  }

  response(value: unknown) {
    if (record(value) && Array.isArray(value.content)) {
      for (const block of value.content) {
        const tool = this.tool(block);
        if (tool) {
          this.remember(tool);
        }
      }
    }
  }

  event(value: unknown) {
    if (!record(value) || typeof value.index !== 'number') {
      return;
    }
    if (value.type === 'content_block_start') {
      const tool = this.tool(value.content_block);
      if (tool) {
        this.blocks.set(value.index, { ...tool, json: '' });
      }
      return;
    }
    const tool = this.blocks.get(value.index);
    if (!tool) {
      return;
    }
    if (value.type === 'content_block_delta' && record(value.delta)) {
      this.append(tool, value.delta.partial_json);
    }
    if (value.type === 'content_block_stop') {
      this.remember({ ...tool, input: tool.json ? JSON.parse(tool.json) : tool.input });
      this.blocks.delete(value.index);
    }
  }

  private append(tool: Tool & { json: string }, delta: unknown) {
    if (typeof delta === 'string') {
      tool.json += delta;
      if (Buffer.byteLength(tool.json) > MAX_BYTES) {
        throw new Error('Observed tool input exceeds 8 MiB');
      }
    }
  }

  private tool(value: unknown): Tool | undefined {
    if (
      record(value) &&
      value.type === 'tool_use' &&
      typeof value.id === 'string' &&
      typeof value.name === 'string'
    ) {
      return { id: value.id, name: value.name, input: value.input };
    }
    return undefined;
  }
}

/** Incremental SSE reader for observation only; it throws when it cannot keep up. */
class SseObserver {
  private decoder = new TextDecoder();
  private pending = '';
  private data: string[] = [];
  private dataBytes = 0;
  private observer: ToolObserver;

  constructor(observer: ToolObserver) {
    this.observer = observer;
  }

  push(chunk: Uint8Array) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    // Split first: a chunk may hold many complete events, and only an incomplete line or
    // event that outgrows the bound is a reason to stop observing.
    for (let index = this.pending.indexOf('\n'); index !== -1; index = this.pending.indexOf('\n')) {
      const line = this.pending.slice(0, index).replace(/\r$/, '');
      this.pending = this.pending.slice(index + 1);
      this.line(line);
    }
    if (this.pending.length > MAX_BYTES) {
      throw new Error('Observed SSE line exceeds 8 MiB');
    }
  }

  private line(line: string) {
    if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      this.dataBytes += value.length;
      if (this.dataBytes > MAX_BYTES) {
        throw new Error('Observed SSE event exceeds 8 MiB');
      }
      this.data.push(value);
    } else if (!line && this.data.length) {
      const value = this.data.join('\n');
      this.data = [];
      this.dataBytes = 0;
      this.observer.event(JSON.parse(value));
    }
  }
}

/** Observation of one response body; once it cannot keep up it stops and says why. */
class BestEffortObservation {
  private readonly observer: ToolObserver;
  private readonly streamed: boolean;
  private readonly stopped: (reason: string) => void;
  private readonly sse: SseObserver;
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private observing = true;

  constructor(
    remember: (tool: Tool) => void,
    streamed: boolean,
    stopped: (reason: string) => void,
  ) {
    this.observer = new ToolObserver(remember);
    this.sse = new SseObserver(this.observer);
    this.streamed = streamed;
    this.stopped = stopped;
  }

  push(chunk: Uint8Array) {
    if (!this.observing) {
      return;
    }
    try {
      this.accept(chunk);
    } catch (error) {
      this.stop(error);
    }
  }

  finish() {
    if (!this.observing || this.streamed) {
      return;
    }
    try {
      this.observer.response(JSON.parse(Buffer.concat(this.chunks).toString('utf8')));
    } catch (error) {
      this.stop(error);
    }
  }

  private accept(chunk: Uint8Array) {
    if (this.streamed) {
      this.sse.push(chunk);
      return;
    }
    this.bytes += chunk.length;
    if (this.bytes > MAX_BYTES) {
      throw new Error('Observed response exceeds 8 MiB');
    }
    this.chunks.push(chunk);
  }

  private stop(error: unknown) {
    this.observing = false;
    this.chunks = [];
    this.stopped(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Pass the upstream bytes through unchanged and observe them on the side. An
 * observation failure (partial tool JSON, oversized input) only stops observing;
 * it never reaches Claude Code, and `stopped` records why. The passthrough itself
 * has no size cap.
 */
export async function forwardObservedTools(
  upstream: Response,
  res: ServerResponse,
  remember: (tool: Tool) => void,
  signal: AbortSignal,
  stopped: (reason: string) => void = () => {},
) {
  if (!upstream.body) {
    res.end();
    return;
  }
  const streamed = Boolean(upstream.headers.get('content-type')?.includes('text/event-stream'));
  const observation = new BestEffortObservation(remember, streamed, stopped);
  for await (const chunk of upstream.body) {
    if (!res.write(chunk)) {
      await once(res, 'drain', { signal });
    }
    observation.push(chunk);
  }
  observation.finish();
  res.end();
}

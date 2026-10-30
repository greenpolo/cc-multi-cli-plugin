import { setBounded } from './bounded.ts';
import { isProviderWorker } from './provider-workers.ts';
import { isRecord } from './record.ts';

export type RememberWorkerModel = (id: string, type: string, model: string) => void;

/** Normalize once, before a built block enters either the stream or the saved content. */
export function stripWorkerModel(block: unknown, remember: RememberWorkerModel): boolean {
  if (!isRecord(block) || block.type !== 'tool_use' || block.name !== 'Agent') {
    return false;
  }
  const input = block.input;
  if (
    !isRecord(input) ||
    !isProviderWorker(input.subagent_type) ||
    typeof input.model !== 'string'
  ) {
    return false;
  }
  if (typeof block.id !== 'string') {
    return false;
  }
  remember(block.id, String(input.subagent_type), input.model);
  const { model: _model, ...rest } = input;
  block.input = rest;
  return true;
}

/** Retain selections on lookup: spawn admission can be denied or retried. */
export class WorkerModels {
  private readonly models = new Map<string, { session: string; type: string; model: string }>();

  remember(session: string): RememberWorkerModel {
    return (id, type, model) => {
      setBounded(this.models, JSON.stringify([session, id]), { session, type, model }, 2048, 'lru');
    };
  }

  selection(value: Record<string, unknown>): Record<string, unknown> {
    if (
      !isProviderWorker(value.subagentType) ||
      value.fork ||
      typeof value.toolUseId !== 'string'
    ) {
      return value;
    }
    const scoped = this.models.get(JSON.stringify([value.sessionId, value.toolUseId]));
    // Older clients may identify no session on Messages requests. Only those records
    // fall back to globally unique tool_use ids; identified sessions never share them.
    const held = scoped ?? this.models.get(JSON.stringify(['', value.toolUseId]));
    return held && held.type === value.subagentType ? { ...value, model: held.model } : value;
  }

  forgetSession(session: string): void {
    for (const [key, held] of this.models) {
      if (held.session === session) {
        this.models.delete(key);
      }
    }
  }
}

/** JSON fallback preserves the original bytes unless a provider Agent model was removed. */
export function stripWorkerJson(raw: Buffer, remember: RememberWorkerModel): Buffer {
  try {
    const reply: unknown = JSON.parse(raw.toString('utf8'));
    if (!isRecord(reply) || !Array.isArray(reply.content)) {
      return raw;
    }
    let changed = false;
    for (const block of reply.content) {
      changed = stripWorkerModel(block, remember) || changed;
    }
    return changed ? Buffer.from(JSON.stringify(reply)) : raw;
  } catch {
    return raw;
  }
}

interface PendingAgent {
  id: string;
  frames: Buffer[];
  parts: string[];
}

function frameData(frame: Buffer): Record<string, unknown> | undefined {
  const data = frame
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Only Agent JSON deltas wait for block_stop; pings and all other frames pass verbatim. */
class WorkerFrames {
  private readonly agents = new Map<number, PendingAgent>();
  private readonly remember: RememberWorkerModel;

  constructor(remember: RememberWorkerModel) {
    this.remember = remember;
  }

  frame(frame: Buffer): Buffer[] {
    const data = frameData(frame);
    if (!data || typeof data.index !== 'number') {
      return [frame];
    }
    const block = data.content_block;
    if (
      data.type === 'content_block_start' &&
      isRecord(block) &&
      block.type === 'tool_use' &&
      block.name === 'Agent' &&
      typeof block.id === 'string'
    ) {
      this.agents.set(data.index, { id: block.id, frames: [], parts: [] });
    }
    const agent = this.agents.get(data.index);
    if (!agent) {
      return [frame];
    }
    if (
      data.type === 'content_block_delta' &&
      isRecord(data.delta) &&
      data.delta.type === 'input_json_delta' &&
      typeof data.delta.partial_json === 'string'
    ) {
      agent.frames.push(frame);
      agent.parts.push(data.delta.partial_json);
      return [];
    }
    if (data.type !== 'content_block_stop') {
      return [frame];
    }
    this.agents.delete(data.index);
    return [...this.finish(agent, data.index), frame];
  }

  private finish(agent: PendingAgent, index: number): Buffer[] {
    try {
      const block = {
        type: 'tool_use',
        name: 'Agent',
        id: agent.id,
        input: JSON.parse(agent.parts.join('')),
      };
      if (stripWorkerModel(block, this.remember)) {
        const data = {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        };
        return [Buffer.from(`event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`)];
      }
    } catch {
      // Malformed input is Anthropic's to handle, never a reason to change the reply.
    }
    return agent.frames;
  }

  remaining(): Buffer[] {
    return [...this.agents.values()].flatMap((agent) => agent.frames);
  }
}

/** Byte framing avoids corrupting split UTF-8 codepoints and preserves CRLF verbatim. */
export async function* stripWorkerSse(
  source: AsyncIterable<Uint8Array>,
  remember: RememberWorkerModel,
): AsyncGenerator<Buffer> {
  const frames = new WorkerFrames(remember);
  let pending = Buffer.alloc(0);
  for await (const chunk of source) {
    pending = Buffer.concat([pending, chunk]);
    let delimiter = /\r?\n\r?\n/.exec(pending.toString('latin1'));
    while (delimiter) {
      const end = delimiter.index + delimiter[0].length;
      yield* frames.frame(pending.subarray(0, end));
      pending = pending.subarray(end);
      delimiter = /\r?\n\r?\n/.exec(pending.toString('latin1'));
    }
  }
  yield* frames.remaining();
  if (pending.length) {
    yield pending;
  }
}

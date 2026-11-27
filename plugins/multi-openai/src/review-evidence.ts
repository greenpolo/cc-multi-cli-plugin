import { createHash } from 'node:crypto';
import type { MessagesRequest, RequestMessage } from '../../multi-core/src/gateway/messages.ts';
import { isRecord } from '../../multi-core/src/gateway/record.ts';
import type { ReviewInput } from '../../multi-core/src/gateway/verdicts.ts';

// The Codex CLI's auto-review sends a compact transcript, not the whole session,
// and keeps one reviewer thread per session so a later review adds only what is
// new. These budgets keep one review near the Codex size: a few thousand tokens
// once the thread exists, and about 25k tokens when it starts.
const entryBudget = { message: 8 * 1024, tool: 4 * 1024 };
const transcriptBudget = { message: 40 * 1024, tool: 40 * 1024 };
const recentEntryLimit = 40;
const actionBudget = 16 * 1024;
const policyBudget = 16 * 1024;
const systemBudget = 8 * 1024;
const rootBudget = { message: 16 * 1024, tool: 8 * 1024 };

/** One transcript line the reviewer reads: who said or did what, never hidden reasoning. */
interface Entry {
  role: string;
  kind: 'message' | 'tool';
  text: unknown;
}

interface Transcript {
  entries: Entry[];
  omitted_entries?: number;
}

/** What one review sends: the context new to the thread, then the action to judge. */
export interface ReviewEvidence {
  reviewCwd: string;
  /** Transcript the thread has not seen yet, or the thread's opening context. */
  context: string;
  action: string;
  /** Fingerprint of every transcript entry this review accounts for. */
  seen: ThreadMark;
  /** True when `context` extends the thread rather than opening a new one. */
  continued: boolean;
}

/** The part of a reviewer thread that a later review in the same session reuses. */
export interface ThreadMark {
  count: number;
  hash: string;
}

/** Bound cost without refusing long sessions; omissions are explicit evidence gaps. */
export function reviewEvidence(
  cwd: string,
  context: ReviewInput,
  thread?: ThreadMark,
): ReviewEvidence {
  if (context.worker && !context.rootRequest) {
    throw new Error('Worker review is missing root authorization context');
  }
  const reviewCwd = context.cwd ?? cwd;
  const entries = transcriptEntries(context.request.messages ?? []);
  const seen = { count: entries.length, hash: fingerprint(entries) };
  const action = JSON.stringify({
    planned_action: boundedValue({ [context.tool.name]: context.tool.input }, actionBudget),
    user_policy: boundedValue(userPolicy(context.request), policyBudget),
  });
  if (thread && continues(entries, thread)) {
    const delta = recent(entries.slice(thread.count), transcriptBudget);
    return {
      reviewCwd,
      context: JSON.stringify({ transcript_delta: delta }),
      action,
      seen,
      continued: true,
    };
  }
  const opening = {
    model: context.request.model?.slice(0, 256),
    system: boundedValue(context.request.system, systemBudget, true),
    transcript: recent(entries, transcriptBudget),
    root_request:
      context.worker && context.rootRequest
        ? recent(transcriptEntries(context.rootRequest.messages ?? []), rootBudget)
        : undefined,
    cwd: reviewCwd.slice(0, 4096),
  };
  return { reviewCwd, context: JSON.stringify(opening), action, seen, continued: false };
}

/** True when the thread's transcript is still the start of this request's transcript. */
function continues(entries: Entry[], thread: ThreadMark): boolean {
  return (
    entries.length >= thread.count && fingerprint(entries.slice(0, thread.count)) === thread.hash
  );
}

function fingerprint(entries: Entry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** User and assistant text, tool calls and tool output; thinking and cache markers dropped. */
function transcriptEntries(messages: RequestMessage[]): Entry[] {
  const entries: Entry[] = [];
  for (const message of messages) {
    const role = String(message.role).slice(0, 64);
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content;
    for (const block of Array.isArray(blocks) ? blocks : []) {
      const entry = blockEntry(role, block);
      if (entry) {
        entries.push(entry);
      }
    }
  }
  return entries;
}

function blockEntry(role: string, block: unknown): Entry | undefined {
  if (!isRecord(block)) {
    return undefined;
  }
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' && block.text.trim()
        ? { role, kind: 'message', text: boundedValue(block.text, entryBudget.message) }
        : undefined;
    case 'tool_use':
      return {
        role,
        kind: 'tool',
        text: boundedValue({ tool_use: block.name, input: block.input }, entryBudget.tool),
      };
    case 'tool_result':
      return {
        role,
        kind: 'tool',
        text: boundedValue(
          {
            tool_result: toolOutput(block.content),
            is_error: block.is_error === true || undefined,
          },
          entryBudget.tool,
        ),
      };
    case 'image':
    case 'document':
      return { role, kind: 'message', text: `[${block.type} omitted]` };
    default:
      return undefined;
  }
}

function toolOutput(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((part: unknown) =>
    isRecord(part) && part.type === 'text' ? part.text : `[${String(isRecord(part) && part.type)}]`,
  );
}

/**
 * The newest entries within the message and tool budgets, plus the first user
 * message, which usually states the task. Omissions are counted, never hidden.
 */
function recent(entries: Entry[], budget: { message: number; tool: number }): Transcript {
  const kept: Entry[] = [];
  const remaining = { ...budget };
  for (let index = entries.length - 1; index >= 0 && kept.length < recentEntryLimit; index--) {
    const entry = entries[index];
    const size = bytes(entry);
    if (size > remaining[entry.kind]) {
      break;
    }
    remaining[entry.kind] -= size;
    kept.push(entry);
  }
  kept.reverse();
  const first = entries.find((entry) => entry.role === 'user' && entry.kind === 'message');
  const withTask = first && !kept.includes(first) ? [first, ...kept] : kept;
  const omitted = entries.length - withTask.length;
  return omitted > 0 ? { entries: withTask, omitted_entries: omitted } : { entries: withTask };
}

/** The human's auto-mode and permission rules, as Claude Code reports them with the request. */
function userPolicy(request: MessagesRequest) {
  const entry = Array.isArray(request.safeguards)
    ? request.safeguards.find((item) => isRecord(item) && item.type === 'dangerous_tool_use')
    : undefined;
  const context = isRecord(entry) ? entry.classifier_context : undefined;
  if (!isRecord(context)) {
    return undefined;
  }
  const { auto_mode, rules, trusted_directories } = context;
  return { auto_mode, rules, trusted_directories };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null');
}

function boundedValue(value: unknown, budget: number, headOnly = false): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) <= budget) {
    return value;
  }
  // A UTF-16 unit uses at most six bytes when JSON-escaped, even for lone surrogates.
  const units = Math.max(0, Math.floor((budget - 128) / 6));
  const head = headOnly ? units : Math.floor(units / 3);
  return {
    truncated: true,
    original_bytes: Buffer.byteLength(encoded),
    json_head: encoded.slice(0, head),
    ...(headOnly ? {} : { json_tail: encoded.slice(-(units - head)) }),
  };
}

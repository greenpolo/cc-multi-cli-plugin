import { createHash, randomUUID } from 'node:crypto';
import { setBounded } from './bounded.ts';
import type { MessagesRequest } from './messages.ts';
import { isRecord } from './record.ts';

/** Normalize a workspace path for the classifier's omitted-cd comparison. */
export function approvalCwdForComparison(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
) {
  const normalized = cwd.replaceAll('\\', '/');
  const valid = /^(?:[A-Za-z]:)?[A-Za-z0-9_./-]+$/.test(normalized);
  if (!valid || (platform === 'win32' && !/^(?:[A-Za-z]:\/|\/\/)/.test(normalized))) {
    return undefined;
  }
  return normalized;
}

export interface ApprovalContext {
  model: string;
  request: MessagesRequest;
  scope: string;
  cwd?: string;
  worker?: boolean;
  rootRequest?: MessagesRequest;
  /** Claude's plan mode binds this review: only read-only actions may pass. */
  planMode?: boolean;
  /** Claude's current mode, reported with the pending action by its PreToolUse hook. */
  permissionMode?: string;
  /** Mode in the originating model request's safeguard classifier context. */
  requestPermissionMode?: string;
}

export interface ApprovalAction {
  /** Native transcript records, not executable tool calls. */
  transcript: Record<string, unknown>[];
  action: Record<string, unknown>;
  stage: 1 | 2;
  /** Claude's admitted classifier policy, carried separately from transcript data. */
  policy?: string;
}
export interface ApprovalVerdict {
  model: string;
  outcome: 'allow' | 'deny';
}

/** Claude can retry classification using the working model's ID. */
export function isApprovalRequest(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return false;
  }
  return body.messages.some(
    (message) =>
      isRecord(message) &&
      Array.isArray(message.content) &&
      message.content.some(
        (block) => isRecord(block) && block.type === 'text' && block.text === '<transcript>\n',
      ),
  );
}

/** Strict, version-sensitive Claude 2.1.263 classifier envelope. Unknown formats fail closed. */
function approvalEnvelope(body: unknown) {
  if (
    !isRecord(body) ||
    body.stream ||
    (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length)) ||
    !Array.isArray(body.messages) ||
    body.messages.length !== 1
  ) {
    throw new Error('Unsupported approval request');
  }
  const message = body.messages[0];
  if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.content)) {
    throw new Error('Unsupported approval message');
  }
  const text = message.content.map((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('Unsupported approval content');
    }
    return block.text;
  });
  if (
    !isRecord(body.metadata) ||
    typeof body.metadata.user_id !== 'string' ||
    !body.metadata.user_id
  ) {
    throw new Error('Missing approval session identity');
  }
  const policy = approvalPolicy(body.system);
  if (policy !== undefined && policy.length > 131072) {
    throw new Error('Approval policy is too large');
  }
  return { text, session: body.metadata.user_id, policy };
}

function approvalPolicy(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    if (value.length > 131072) {
      throw new Error('Approval policy is too large');
    }
    return value;
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (block) =>
        !isRecord(block) ||
        block.type !== 'text' ||
        typeof block.text !== 'string' ||
        block.text.length > 131072,
    )
  ) {
    throw new Error('Malformed approval policy');
  }
  return value
    .map((block) => String(block.text))
    .filter((text) => !text.startsWith('x-anthropic-billing-header:'))
    .join('\n');
}

function approvalStage(instruction: string | undefined): 1 | 2 {
  if (!instruction?.includes('<severity>N</severity>')) {
    throw new Error('Unsupported approval stage');
  }
  if (instruction.includes('Stage 1 does NOT apply user intent')) {
    return 1;
  }
  if (instruction.includes('Review the classification process and follow it carefully.')) {
    return 2;
  }
  throw new Error('Unsupported approval stage');
}

/** Strict, version-sensitive Claude 2.1.263 classifier envelope. Unknown formats fail closed. */
export function parseApprovalRequest(body: unknown): ApprovalAction & { key: string } {
  const { text, session, policy } = approvalEnvelope(body);
  const close = text.indexOf('</transcript>\n');
  if (text[0] !== '<transcript>\n' || close <= 1 || close !== text.length - 2) {
    throw new Error('Unsupported approval transcript');
  }
  const stage = approvalStage(text.at(-1));
  const transcript: Record<string, unknown>[] = text.slice(1, close).flatMap((block) =>
    block
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const entry: unknown = JSON.parse(line);
        if (!isRecord(entry)) {
          throw new Error('Unsupported approval transcript entry');
        }
        return entry;
      }),
  );
  const action = transcript.at(-1);
  if (
    !action ||
    Object.keys(action).length !== 1 ||
    ['user', 'assistant'].includes(Object.keys(action)[0])
  ) {
    throw new Error('Missing proposed approval action');
  }
  const key = createHash('sha256')
    .update(JSON.stringify([session, transcript, policy ?? null]))
    .digest('hex');
  return { transcript, action, stage, key, ...(policy ? { policy } : {}) };
}

/** Edit tools that plan mode forbids outright, whatever the reviewer would decide. */
const PLAN_MODE_WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function planModeDenial(action: Record<string, unknown>, context?: ApprovalContext) {
  const tool = Object.keys(action)[0];
  return context?.planMode && tool !== undefined && PLAN_MODE_WRITES.has(tool)
    ? { model: 'multi-plan-mode', outcome: 'deny' as const }
    : undefined;
}

/** Adapts provider allow/block verdicts AFTER Claude's own permission filtering.
 * Explicitly opt in only for a provider/session whose review capability is known.
 * This does not select providers, broaden permissions, or implement a risk heuristic.
 */
export class NativeApprovalBridge {
  private denied = new Map<string, { verdict: ApprovalVerdict; expires: number }>();

  private review: (
    input: ApprovalAction,
    signal: AbortSignal,
    context?: ApprovalContext,
  ) => Promise<ApprovalVerdict>;

  constructor(
    review: (
      input: ApprovalAction,
      signal: AbortSignal,
      context?: ApprovalContext,
    ) => Promise<ApprovalVerdict>,
  ) {
    this.review = review;
  }

  async respond(body: unknown, signal: AbortSignal, context?: ApprovalContext) {
    const input = parseApprovalRequest(body);
    input.key += context ? JSON.stringify([context.scope, context.model, context.cwd]) : '';
    signal.throwIfAborted();
    const now = Date.now();
    for (const [key, item] of this.denied) {
      if (item.expires <= now) {
        this.denied.delete(key);
      }
    }
    let verdict: ApprovalVerdict;
    if (input.stage === 2) {
      const cached = this.denied.get(input.key);
      this.denied.delete(input.key);
      if (!cached) {
        throw new Error('Approval second stage has no matching recent denial');
      }
      verdict = cached.verdict;
    } else {
      // A retry/new first stage always reviews again. Never reuse an old allow.
      this.denied.delete(input.key);
      verdict =
        planModeDenial(input.action, context) ?? (await this.review(input, signal, context));
      signal.throwIfAborted();
      if (
        !verdict ||
        !['allow', 'deny'].includes(verdict.outcome) ||
        typeof verdict.model !== 'string' ||
        !verdict.model
      ) {
        throw new Error('Invalid provider approval verdict');
      }
      this.rememberDenial(input.key, verdict);
    }
    signal.throwIfAborted();
    return {
      message: {
        id: `review_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: verdict.model,
        content: [
          { type: 'text', text: `<severity>${verdict.outcome === 'allow' ? 0 : 100}</severity>` },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      stage: input.stage,
      outcome: verdict.outcome,
      cached: input.stage === 2,
    };
  }

  private rememberDenial(key: string, verdict: ApprovalVerdict) {
    if (verdict.outcome !== 'deny') {
      return;
    }
    // Only denials cross stages; the oldest one is evicted at the fixed cache limit.
    setBounded(
      this.denied,
      key,
      { verdict: { ...verdict }, expires: Date.now() + 60000 },
      64,
      'insertion',
    );
  }
}

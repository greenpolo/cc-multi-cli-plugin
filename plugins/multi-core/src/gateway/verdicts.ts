import type { MessagesRequest, MessagesResponse, ResponseContentBlock } from './messages.ts';
import { type AutoReviewPolicy, harnessProvider } from './provider.ts';
import { isRecord } from './record.ts';

export type ReviewVerdict = { model: string; outcome: 'allow' | 'deny'; reason?: string };
export interface ReviewInput {
  tool: Extract<ResponseContentBlock, { type: 'tool_use' }>;
  request: MessagesRequest;
  rootRequest?: MessagesRequest;
  worker?: boolean;
  cwd?: string;
  planMode: boolean;
}
export type Reviewer = (input: ReviewInput, signal: AbortSignal) => Promise<ReviewVerdict>;
type ToolVerdict =
  | { type: 'evaluated'; outcome: 'not_flagged' }
  | { type: 'evaluated'; outcome: 'flagged'; explanation: string };
export type SafeguardResults = [
  {
    type: 'dangerous_tool_use';
    status: { type: 'available'; tool_uses: Record<string, ToolVerdict> };
  },
];

export function dangerousToolMode(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }
  const entry = value.find((item: unknown) => isRecord(item) && item.type === 'dangerous_tool_use');
  const context: unknown = isRecord(entry) ? entry.classifier_context : undefined;
  return isRecord(context) && typeof context.permission_mode === 'string'
    ? context.permission_mode
    : '';
}

const unreviewedModes = new Set(['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
const readOnly = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);
const writes = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const allowed: ToolVerdict = { type: 'evaluated', outcome: 'not_flagged' };
const blocked = (explanation: string): ToolVerdict => ({
  type: 'evaluated',
  outcome: 'flagged',
  explanation,
});

/** Explanations are prose: Claude interprets a trailing bracket as a rule name. */
function prose(value: string): string {
  return (
    value.replace(/[[\]]/g, '').trim().slice(0, 500) || 'The action was refused by the reviewer.'
  );
}

export async function verdictsFor(
  request: MessagesRequest,
  reply: MessagesResponse,
  policy: AutoReviewPolicy,
  reviewer: Reviewer | undefined,
  signal: AbortSignal,
  context: Pick<ReviewInput, 'rootRequest' | 'cwd' | 'worker'> = {},
  onReview: (tool: string, verdict: ReviewVerdict) => void = () => {},
): Promise<SafeguardResults | undefined> {
  if (request.safeguards === undefined) {
    return undefined;
  }
  const mode = dangerousToolMode(request.safeguards);
  const tools = reply.content.filter((block) => block.type === 'tool_use');
  const entries: Array<[string, ToolVerdict]> = [];
  // Four independent workers bound concurrent subscription requests per reply.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, tools.length) }, async () => {
      while (next < tools.length) {
        const tool = tools[next++];
        const verdict = await toolVerdict(
          tool,
          mode,
          policy,
          reviewer,
          request,
          signal,
          context,
          onReview,
        );
        entries.push([tool.id, verdict]);
      }
    }),
  );
  return [
    {
      type: 'dangerous_tool_use',
      status: { type: 'available', tool_uses: Object.fromEntries(entries) },
    },
  ];
}

async function toolVerdict(
  tool: ReviewInput['tool'],
  mode: string,
  policy: AutoReviewPolicy,
  reviewer: Reviewer | undefined,
  request: MessagesRequest,
  signal: AbortSignal,
  context: Pick<ReviewInput, 'rootRequest' | 'cwd' | 'worker'>,
  onReview: (tool: string, verdict: ReviewVerdict) => void,
): Promise<ToolVerdict> {
  if (!unreviewedModes.has(mode) && mode !== 'plan') {
    return blocked('The permission mode is unavailable or unknown.');
  }
  // A harness reply carries only rows for finished native actions and the hand-back;
  // the harness applied the prompt-boundary mode itself, so nothing is left to judge.
  if (harnessProvider(request.model) || readOnly.has(tool.name)) {
    return allowed;
  }
  if (mode === 'plan' && writes.has(tool.name)) {
    return blocked('Plan mode does not permit file changes.');
  }
  if (policy.review !== 'reviewer' || !reviewer) {
    return mode === 'plan'
      ? blocked('Plan mode: actions without a reviewer are refused.')
      : allowed;
  }
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    const verdict = await boundedReview(
      reviewer,
      { tool, request, ...context, planMode: mode === 'plan' },
      deadline,
    );
    onReview(tool.name, verdict);
    return verdict.outcome === 'allow'
      ? allowed
      : blocked(prose(verdict.reason ?? 'The OpenAI reviewer refused this action.'));
  } catch {
    onReview(tool.name, { model: 'codex-auto-review', outcome: 'deny' });
    return blocked('The OpenAI reviewer could not complete its review. The action was refused.');
  }
}

function boundedReview(
  reviewer: Reviewer,
  input: ReviewInput,
  signal: AbortSignal,
): Promise<ReviewVerdict> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Review deadline exceeded'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return reviewer(input, signal);
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

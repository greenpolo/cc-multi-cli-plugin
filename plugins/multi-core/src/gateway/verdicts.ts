import type { MessagesRequest, MessagesResponse } from './messages.ts';
import { harnessProvider } from './provider.ts';
import { isRecord } from './record.ts';

type ToolVerdict =
  | { type: 'evaluated'; outcome: 'not_flagged' }
  | { type: 'evaluated'; outcome: 'flagged'; explanation: string };
export type SafeguardResults = [
  {
    type: 'dangerous_tool_use';
    status: { type: 'available'; tool_uses: Record<string, ToolVerdict> };
  },
];

function dangerousToolMode(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }
  const entry = value.find((item: unknown) => isRecord(item) && item.type === 'dangerous_tool_use');
  const context: unknown = isRecord(entry) ? entry.classifier_context : undefined;
  return isRecord(context) && typeof context.permission_mode === 'string'
    ? context.permission_mode
    : '';
}

const readOnly = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);
// Claude Code 2.1.306 coordination/UI tools: they do not perform machine actions.
// TaskStop, worktree and scheduling tools are deliberately absent.
const controls = new Set([
  'TodoWrite',
  'SubagentHandback',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'Agent',
  'Task',
  'Skill',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
]);
const writes = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const allowed: ToolVerdict = { type: 'evaluated', outcome: 'not_flagged' };
const planLookups = new Set(['WebSearch', 'WebFetch']);

const blocked = (explanation: string): ToolVerdict => ({
  type: 'evaluated',
  outcome: 'flagged',
  explanation,
});

/**
 * Claude Code asks for a verdict on each tool use when its request carries
 * `safeguards`. Multi makes no model call for it: Claude's own mode and rules decide.
 * Plan refuses actions; every other mode lets them run.
 */
export function verdictsFor(
  request: MessagesRequest,
  reply: MessagesResponse,
): SafeguardResults | undefined {
  if (request.safeguards === undefined) {
    return undefined;
  }
  const plan = dangerousToolMode(request.safeguards) === 'plan';
  const entries = reply.content
    .filter((block) => block.type === 'tool_use')
    .map((tool) => [tool.id, toolVerdict(tool.name, plan, request.model)] as const);
  return [
    {
      type: 'dangerous_tool_use',
      status: { type: 'available', tool_uses: Object.fromEntries(entries) },
    },
  ];
}

function toolVerdict(name: string, plan: boolean, model: unknown): ToolVerdict {
  // A harness reply carries only rows for finished native actions and the hand-back;
  // the harness applied the prompt-boundary mode itself, so nothing is left to judge.
  if (!plan || harnessProvider(model) || readOnly.has(name) || controls.has(name)) {
    return allowed;
  }
  if (writes.has(name)) {
    return blocked('Plan mode does not permit file changes.');
  }
  // Claude's own Plan lets web lookups run, so they do here too.
  return planLookups.has(name) ? allowed : blocked('Plan mode does not permit actions.');
}

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AgentModeOption, AgentOptions, ToolName } from '@cursor/sdk';
import { nativeMode, nativeRules } from '../../multi-core/src/gateway/harness-settings.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';

/** Cursor tools reachable from each Claude tool. */
const TOOL_MAP: Readonly<Record<string, readonly ToolName[]>> = {
  Bash: ['shell'],
  Read: ['read', 'ls'],
  Edit: ['edit', 'delete'],
  Write: ['edit', 'delete'],
  Grep: ['grep'],
  Glob: ['glob'],
  WebSearch: ['webSearch'],
  WebFetch: ['webFetch'],
  Agent: ['task'],
  Task: ['task'],
};

/** Plan is read-only: Cursor's own shell, edits, subagents, MCP and media go. */
const PLAN_REMOVED: readonly ToolName[] = [
  'shell',
  'edit',
  'delete',
  'task',
  'mcp',
  'generateImage',
];

/** Planning state; it acts on nothing outside the run. */
const ALWAYS_LISTED: readonly ToolName[] = ['updateTodos', 'readTodos'];

function cursorNames(claudeTool: string): readonly ToolName[] {
  return TOOL_MAP[claudeTool] ?? (claudeTool.startsWith('mcp__') ? ['mcp'] : []);
}

/**
 * Cursor keeps its whole toolset, its own MCP servers and subagents included, minus what
 * Claude denies. An explicit Claude tool list (an agent type's `tools`) is the one allowlist.
 * Cursor has no per-server MCP rule, so any Claude `mcp__` deny rule removes all of its MCP.
 */
function cursorTools(
  context: PermissionContext,
  plan: boolean,
): { tools?: ToolName[]; disallowedTools: ToolName[] } {
  const { allowed, denied } = nativeRules(context);
  const removed = new Set<ToolName>(plan ? PLAN_REMOVED : []);
  for (const [claudeTool, natives] of Object.entries(TOOL_MAP)) {
    if (denied.has(claudeTool)) {
      for (const native of natives) {
        removed.add(native);
      }
    }
  }
  if ([...denied].some((rule) => rule.startsWith('mcp__'))) {
    removed.add('mcp');
  }
  if (allowed === undefined) {
    return { disallowedTools: [...removed] };
  }
  const listed = new Set<ToolName>([...ALWAYS_LISTED, ...[...allowed].flatMap(cursorNames)]);
  return {
    tools: [...listed].filter((tool) => !removed.has(tool)),
    disallowedTools: [...removed],
  };
}

/** A prompt-time policy; reapply tools on SDK resume because they are not persisted. */
export function cursorPermissionPolicy(context: PermissionContext): {
  mode: AgentModeOption;
  tools?: ToolName[];
  disallowedTools: ToolName[];
  identity: string;
  autoReview: boolean;
  notice?: string;
} {
  const native = nativeMode(context.permissionMode);
  const mode: AgentModeOption = native.mode === 'plan' ? 'plan' : 'agent';
  const { tools, disallowedTools } = cursorTools(context, mode === 'plan');
  const autoReview = native.mode !== 'bypassPermissions';
  const notice = [native.notice, context.notice].filter(Boolean).join(' ') || undefined;
  return {
    mode,
    ...(tools ? { tools } : {}),
    disallowedTools,
    autoReview,
    notice,
    identity: JSON.stringify([mode, tools ?? null, disallowedTools, autoReview]),
  };
}

/** Native permissions belong to Cursor. Never replace its sandbox configuration. */
export async function cursorNativePermissions(
  cwd: string,
  context: PermissionContext = { permissionMode: 'auto' },
): Promise<Pick<AgentOptions, 'tools' | 'disallowedTools' | 'local'>> {
  const policy = cursorPermissionPolicy(context);
  if (!path.isAbsolute(cwd)) {
    throw new Error('Native Cursor requires an absolute workspace path');
  }
  const workspace = await realpath(cwd);
  return {
    ...(policy.tools ? { tools: policy.tools } : {}),
    disallowedTools: policy.disallowedTools,
    local: {
      cwd: workspace,
      // The user's own Cursor setup loads as it would in Cursor: its MCP servers, rules,
      // hooks and plugins.
      settingSources: ['all'],
      // This requests native review, not a fail-closed availability guarantee.
      // The SDK documents unrestricted fallback when its classifier is unavailable.
      autoReview: policy.autoReview,
      enableAgentRetries: false,
    },
  };
}

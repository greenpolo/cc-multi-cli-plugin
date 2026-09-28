import { nativeToolRules } from '../../multi-core/src/gateway/display-rows.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';

/** Native names reachable from each mapped Claude tool. */
const TOOL_MAP = {
  Read: ['view_file', 'list_dir'],
  Grep: ['grep_search'],
  Glob: ['find_by_name'],
  Bash: ['run_command', 'command_status', 'send_command_input'],
  Write: ['write_to_file'],
  Edit: ['replace_file_content', 'multi_replace_file_content', 'sed_file'],
  WebFetch: ['read_url_content'],
  WebSearch: ['search_web'],
  NotebookEdit: ['notebook_edit'],
} as const;

const PLAN_DENIED_CLAUDE_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);

/**
 * agy's own plan mode only steers its model: with permissions skipped it still runs
 * shell and write tools, and its catalog has side-effecting tools (browser, schedule,
 * messaging) no Claude tool maps to. Plan therefore allows only these read-only tools.
 */
const PLAN_READ_ONLY = [
  ...TOOL_MAP.Read,
  ...TOOL_MAP.Grep,
  ...TOOL_MAP.Glob,
  ...TOOL_MAP.WebFetch,
  ...TOOL_MAP.WebSearch,
];

/** Native child-agent and MCP tools; agy runs with permissions skipped, so these are always denied. */
const ALWAYS_DENIED = [
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'browser_subagent',
  'call_mcp_tool',
  'notebook_execution',
];

export interface AntigravityPolicy {
  denied: string[];
  /** When present, every native tool outside this list is denied, including unknown ones. */
  allowed?: string[];
  plan: boolean;
  notice: string;
}

/** This restricts native tools; it never grants permission in place of native policy. */
export function antigravityPermissionPolicy(context: PermissionContext): AntigravityPolicy {
  if (context.nativePermissionError) {
    throw new Error(context.nativePermissionError);
  }
  if (!['auto', 'acceptEdits', 'plan', 'bypassPermissions'].includes(context.permissionMode)) {
    throw new Error(
      'Antigravity currently supports Auto, acceptEdits, Bypass and Plan; this mode is unsupported.',
    );
  }
  const allowed = toolRules(context.tools);
  const disallowed = toolRules(context.disallowedTools);
  const plan = context.permissionMode === 'plan';
  const denied = new Set<string>(ALWAYS_DENIED);
  for (const [claudeTool, natives] of Object.entries(TOOL_MAP)) {
    const excluded =
      disallowed?.has(claudeTool) ||
      (allowed !== undefined && !allowed.has(claudeTool)) ||
      (plan && PLAN_DENIED_CLAUDE_TOOLS.has(claudeTool));
    if (excluded) {
      for (const native of natives) {
        denied.add(native);
      }
    }
  }
  return {
    denied: [...denied],
    ...(plan ? { allowed: PLAN_READ_ONLY.filter((tool) => !denied.has(tool)) } : {}),
    plan,
    notice: policyNotice(context.permissionMode),
  };
}

/** Every native tool this gateway maps, plus the tools always denied. Used for tool-free turns. */
export function antigravityCompactionDenyList(): string[] {
  return [...new Set([...Object.values(TOOL_MAP).flat(), ...ALWAYS_DENIED])];
}

function policyNotice(mode: PermissionContext['permissionMode']): string {
  if (mode === 'plan') {
    return 'Plan: only native read, search and web lookup tools run.';
  }
  return 'Claude Code rules take precedence; native permission prompts are skipped. No reviewer.';
}

function toolRules(value: string[] | undefined): Set<string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  // A display-row grant (`mcp__multi-core`) draws Claude Code rows; it maps to no native tool.
  const rules = Array.isArray(value) ? nativeToolRules(value) : value;
  const supported = new Set([
    'Read',
    'Grep',
    'Glob',
    'Bash',
    'Edit',
    'Write',
    'WebFetch',
    'WebSearch',
    'NotebookEdit',
    'Agent',
    'Task',
  ]);
  if (!Array.isArray(rules) || rules.some((rule) => !supported.has(rule))) {
    throw new Error('Antigravity cannot enforce this Claude tool restriction.');
  }
  return new Set(rules);
}

function toolList(serialized: string): string[] {
  const tools: unknown = JSON.parse(serialized);
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string')) {
    throw new Error('Invalid native tool policy');
  }
  return tools;
}

/** No policy means an ordinary native CLI session, outside this gateway. */
export function antigravityToolDecision(
  input: unknown,
  serializedPolicy?: string,
  serializedAllowed?: string,
) {
  if (serializedPolicy === undefined) {
    return undefined;
  }
  try {
    const denied = toolList(serializedPolicy);
    const allowed = serializedAllowed === undefined ? undefined : toolList(serializedAllowed);
    if (!input || typeof input !== 'object' || !('toolCall' in input)) {
      throw new Error('Missing native tool call');
    }
    const call = input.toolCall;
    if (!call || typeof call !== 'object' || !('name' in call) || typeof call.name !== 'string') {
      throw new Error('Invalid native tool call');
    }
    if (denied.includes(call.name) || (allowed && !allowed.includes(call.name))) {
      return {
        decision: 'deny',
        reason: 'Claude session policy excludes this native Antigravity tool.',
      };
    }
    return undefined;
  } catch {
    return { decision: 'deny', reason: 'Antigravity gateway permission context is invalid.' };
  }
}

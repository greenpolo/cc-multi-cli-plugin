import { nativeMode, nativeRules } from '../../multi-core/src/gateway/harness-settings.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';
import type { GrokPermissionMode } from './cli.ts';

/**
 * Native tool names as `available_commands` announces them on grok 1.0.35. The
 * allowlist is the only lever measured to bound this set exactly: an unknown
 * `--disallowed-tools` name is accepted and ignored, so removals are expressed as
 * an allowlist and verified against the announced toolset.
 */
export const GROK_TOOLS = [
  'run_terminal_command',
  'read_file',
  'search_replace',
  'list_dir',
  'grep',
  'kill_command_or_subagent',
  'todo_write',
  'get_command_or_subagent_output',
  'spawn_subagent',
  'scheduler_create',
  'scheduler_delete',
  'scheduler_list',
  'monitor',
  'search_tool',
  'use_tool',
  'workflow',
  'enter_plan_mode',
  'exit_plan_mode',
  'ask_user_question',
  'send_feedback',
  'web_search',
  'web_fetch',
  'image_gen',
  'image_edit',
  'image_to_video',
  'reference_to_video',
  'write',
] as const;

/** Native tools reachable from each mapped Claude tool. Grok has no glob tool. */
const TOOL_MAP = {
  Read: ['read_file', 'list_dir'],
  Grep: ['grep'],
  Glob: [],
  Bash: [
    'run_terminal_command',
    'kill_command_or_subagent',
    'get_command_or_subagent_output',
    'monitor',
  ],
  Write: ['write'],
  Edit: ['search_replace'],
  WebFetch: ['web_fetch'],
  WebSearch: ['web_search'],
  NotebookEdit: [],
} as const satisfies Record<string, readonly string[]>;

const PLAN_DENIED_CLAUDE_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);

/** Planning state has no effect outside the native session, so it is always granted. */
const ALWAYS_GRANTED = ['todo_write'];

/**
 * Grok's own tools that no Claude tool maps to: its subagents, scheduler, workflows, MCP
 * broker and media. They belong to the user's Grok setup, so outside Plan they run unless an
 * explicit tool list (an agent type's `tools`, or `--tools`) leaves them out. A headless run
 * has nobody to answer `ask_user_question`, so it is never granted.
 */
const UNMAPPED_TOOLS = [
  'spawn_subagent',
  'scheduler_create',
  'scheduler_delete',
  'scheduler_list',
  'search_tool',
  'use_tool',
  'workflow',
  'send_feedback',
  'image_gen',
  'image_edit',
  'image_to_video',
  'reference_to_video',
];

/**
 * `--tools` bounds the toolset only partly: a measured run that allowed twelve
 * tools was answered with nineteen, the CLI adding its own planning, feedback and
 * media tools. Every tool that was not granted is therefore also removed by name,
 * which was measured to give exactly the requested set.
 *
 * `--disallowed-tools` speaks the CLI's internal ids, and only the shell differs
 * from the name the same CLI announces: `run_terminal_command` there is
 * `run_terminal_cmd` here, and passing the announced name is accepted in silence
 * while the tool keeps running.
 */
const REMOVAL_ALIASES: Readonly<Record<string, string>> = {
  run_terminal_command: 'run_terminal_cmd',
};

/** Blocks native subagent spawning; not a tool name, so it has no counterpart. */
const SUBAGENT_REMOVAL = 'Agent';

/**
 * Deny rules are validated by the CLI and outrank every mode, including Bypass.
 * Their genres are coarser than the tool names: a live run showed `Edit(*)`
 * refusing the `write` tool, so a rule is only emitted when none of the native
 * tools it can reach was granted. Finer restrictions rely on the allowlist,
 * whose effect is verified against the announced toolset.
 */
const DENY_RULES: readonly { rule: string; tools: readonly string[] }[] = [
  { rule: 'Bash(*)', tools: ['run_terminal_command'] },
  { rule: 'Edit(*)', tools: ['search_replace', 'write'] },
  { rule: 'Write(*)', tools: ['write', 'search_replace'] },
  { rule: 'Read(*)', tools: ['read_file', 'list_dir'] },
  { rule: 'Grep(*)', tools: ['grep'] },
  { rule: 'WebFetch(*)', tools: ['web_fetch', 'web_search'] },
];

/**
 * MCP tools are added to the model's toolset once their servers connect, whatever the
 * allowlist holds, so where MCP must not run its execution is denied by rule. The CLI's
 * rule has no per-server form measured, so any Claude `mcp__` deny rule denies all of it.
 */
const MCP_DENY_RULE = 'MCPTool(*)';

export interface GrokPolicy {
  mode: GrokPermissionMode;
  /** Absent when nothing bounds the toolset: Grok keeps every tool it has. */
  tools?: string[];
  disallowedTools: string[];
  deny: string[];
  /** Native names that must never appear in an announced toolset. */
  forbidden: string[];
  notice: string;
}

/** Grok Build runs Plan as Plan and every other Claude mode as Bypass. */
function grokMode(mode: PermissionContext['permissionMode']): GrokPermissionMode {
  return nativeMode(mode).mode;
}

/** MCP runs outside Plan unless Claude denies some of it or a tool list names none of it. */
function mcpAllowed(context: PermissionContext, plan: boolean): boolean {
  const { allowed, denied } = nativeRules(context);
  const mcp = (rule: string) => rule.startsWith('mcp__');
  if (plan || [...denied].some(mcp)) {
    return false;
  }
  return allowed === undefined || [...allowed].some(mcp);
}

function grantedTools(context: PermissionContext, plan: boolean): Set<string> {
  const { allowed, denied: disallowed } = nativeRules(context);
  const granted = new Set<string>(ALWAYS_GRANTED);
  if (!plan && allowed === undefined) {
    for (const tool of UNMAPPED_TOOLS) {
      granted.add(tool);
    }
  }
  for (const [claudeTool, natives] of Object.entries(TOOL_MAP)) {
    const excluded =
      disallowed.has(claudeTool) ||
      (allowed !== undefined && !allowed.has(claudeTool)) ||
      (plan && PLAN_DENIED_CLAUDE_TOOLS.has(claudeTool));
    if (!excluded) {
      for (const native of natives) {
        granted.add(native);
      }
    }
  }
  if (plan) {
    // Plan mode only changes behavior natively; the native plan tools stay available
    // so the agent can propose, while shell, edit and write are removed outright.
    granted.add('enter_plan_mode');
    granted.add('exit_plan_mode');
  }
  return granted;
}

function denyRules(granted: ReadonlySet<string>, mcp: boolean): string[] {
  const rules = DENY_RULES.filter(({ tools }) => !tools.some((tool) => granted.has(tool))).map(
    ({ rule }) => rule,
  );
  return mcp ? rules : [...rules, MCP_DENY_RULE];
}

function policy(
  mode: GrokPermissionMode,
  granted: ReadonlySet<string>,
  notice: string,
  options: { mcp?: boolean; bounded?: boolean } = {},
): GrokPolicy {
  const mcp = options.mcp ?? false;
  const forbidden = GROK_TOOLS.filter((tool) => !granted.has(tool));
  const removals = forbidden.map((tool) => REMOVAL_ALIASES[tool] ?? tool);
  return {
    mode,
    // Unbounded runs pass no `--tools`, so a tool a newer Grok adds is available too.
    ...(options.bounded === false ? {} : { tools: GROK_TOOLS.filter((tool) => granted.has(tool)) }),
    disallowedTools: granted.has('spawn_subagent') ? removals : [SUBAGENT_REMOVAL, ...removals],
    deny: denyRules(granted, mcp),
    forbidden,
    notice,
  };
}

/** This restricts native tools; it never grants permission in place of native policy. */
export function grokPermissionPolicy(context: PermissionContext): GrokPolicy {
  const mode = grokMode(context.permissionMode);
  const plan = mode === 'plan';
  const mcp = mcpAllowed(context, plan);
  const notice = [
    policyNotice(mode, mcp),
    nativeMode(context.permissionMode).notice,
    context.notice,
  ]
    .filter(Boolean)
    .join(' ');
  const bounded = plan || nativeRules(context).allowed !== undefined;
  return policy(mode, grantedTools(context, plan), notice, { mcp, bounded });
}

/** A summary turn runs with planning state only and no way to touch the workspace. */
export function grokCompactionPolicy(): GrokPolicy {
  return policy('plan', new Set(ALWAYS_GRANTED), 'Compaction summary; native tools disabled.');
}

function policyNotice(mode: GrokPermissionMode, mcp: boolean): string {
  if (mode === 'plan') {
    return 'Plan: native shell, edits and delegation are blocked.';
  }
  return mcp
    ? "Claude Code rules take precedence; Grok's own MCP servers and agents are available."
    : 'Claude Code rules take precedence; MCP execution is denied by a Claude rule.';
}

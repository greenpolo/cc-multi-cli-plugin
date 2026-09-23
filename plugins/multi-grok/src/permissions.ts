import { nativeToolRules } from '../../multi-core/src/gateway/display-rows.ts';
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

const SUPPORTED_CLAUDE_TOOLS = new Set([...Object.keys(TOOL_MAP), 'Agent', 'Task']);

const PLAN_DENIED_CLAUDE_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);

/** Planning state has no effect outside the native session, so it is always granted. */
const ALWAYS_GRANTED = ['todo_write'];

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
 * allowlist holds, so their execution is denied by rule and their exposure documented.
 */
const MCP_DENY_RULE = 'MCPTool(*)';

export interface GrokPolicy {
  mode: GrokPermissionMode;
  tools: string[];
  disallowedTools: string[];
  deny: string[];
  /** Native names that must never appear in an announced toolset. */
  forbidden: string[];
  notice: string;
}

function grokMode(mode: PermissionContext['permissionMode']): GrokPermissionMode {
  if (
    mode === 'auto' ||
    mode === 'acceptEdits' ||
    mode === 'plan' ||
    mode === 'bypassPermissions'
  ) {
    return mode;
  }
  throw new Error(
    'Grok currently supports Auto, acceptEdits, Bypass and Plan; this mode is unsupported.',
  );
}

function toolRules(value: string[] | undefined): Set<string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  // A display-row grant (`mcp__multi-core`) draws Claude Code rows; it maps to no native tool.
  const rules = Array.isArray(value) ? nativeToolRules(value) : value;
  if (!Array.isArray(rules) || rules.some((rule) => !SUPPORTED_CLAUDE_TOOLS.has(rule))) {
    throw new Error('Grok cannot enforce this Claude tool restriction.');
  }
  return new Set(rules);
}

function grantedTools(context: PermissionContext, plan: boolean): Set<string> {
  const allowed = toolRules(context.tools);
  const disallowed = toolRules(context.disallowedTools);
  const granted = new Set<string>(ALWAYS_GRANTED);
  for (const [claudeTool, natives] of Object.entries(TOOL_MAP)) {
    const excluded =
      disallowed?.has(claudeTool) ||
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

function denyRules(granted: ReadonlySet<string>): string[] {
  const rules = DENY_RULES.filter(({ tools }) => !tools.some((tool) => granted.has(tool))).map(
    ({ rule }) => rule,
  );
  return [...rules, MCP_DENY_RULE];
}

function policy(
  mode: GrokPermissionMode,
  granted: ReadonlySet<string>,
  notice: string,
): GrokPolicy {
  const forbidden = GROK_TOOLS.filter((tool) => !granted.has(tool));
  return {
    mode,
    tools: GROK_TOOLS.filter((tool) => granted.has(tool)),
    disallowedTools: [SUBAGENT_REMOVAL, ...forbidden.map((tool) => REMOVAL_ALIASES[tool] ?? tool)],
    deny: denyRules(granted),
    forbidden,
    notice,
  };
}

/** This restricts native tools; it never grants permission in place of native policy. */
export function grokPermissionPolicy(context: PermissionContext): GrokPolicy {
  if (context.nativePermissionError) {
    throw new Error(context.nativePermissionError);
  }
  const mode = grokMode(context.permissionMode);
  const plan = mode === 'plan';
  return policy(mode, grantedTools(context, plan), policyNotice(mode));
}

/** A summary turn runs with planning state only and no way to touch the workspace. */
export function grokCompactionPolicy(): GrokPolicy {
  return policy('plan', new Set(ALWAYS_GRANTED), 'Compaction summary; native tools disabled.');
}

function policyNotice(mode: GrokPermissionMode): string {
  if (mode === 'plan') {
    return 'Plan: native shell, edits and delegation are blocked.';
  }
  return 'Claude Code rules take precedence; MCP execution is denied. No reviewer.';
}

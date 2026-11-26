import os from 'node:os';
import path from 'node:path';
import { nativeMode, nativeRules } from '../../multi-core/src/gateway/harness-settings.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';

/** Native names reachable from each mapped Claude tool. */
/** agy's config root, which holds hooks and settings on every platform; see configRoot in hooks.ts. */
function antigravityProtectedRoots(
  options: { platform?: NodeJS.Platform; homedir?: string } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? os.homedir();
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return [join(home, '.gemini')];
}

const TOOL_MAP = {
  // agy 1.5.18 reads, writes and edits with read_file, write_file and edit_file; older
  // builds used the other names, which it still announces.
  Read: ['view_file', 'list_dir', 'read_file'],
  Grep: ['grep_search'],
  Glob: ['find_by_name'],
  Bash: ['run_command', 'command_status', 'send_command_input'],
  Write: ['write_to_file', 'write_file'],
  Edit: ['replace_file_content', 'multi_replace_file_content', 'sed_file', 'edit_file'],
  WebFetch: [
    'read_url_content',
    'open_browser_url',
    'read_browser_page',
    'list_browser_pages',
    'execute_browser_javascript',
    'capture_browser_console_logs',
    'capture_browser_screenshot',
    'click_browser_pixel',
    'browser_click_element',
    'browser_drag_pixel_to_pixel',
    'browser_get_dom',
    'browser_get_network_request',
    'browser_input',
    'browser_list_network_requests',
    'browser_mouse_down',
    'browser_mouse_up',
    'browser_move_mouse',
    'browser_press_key',
    'browser_refresh_page',
    'browser_resize_window',
    'browser_scroll',
    'browser_scroll_dom',
    'browser_select_option',
  ],
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
  // Plan reads pages as text; driving a browser can submit forms and run scripts.
  'read_url_content',
  ...TOOL_MAP.WebSearch,
];

/** Control tools agy needs to finish a turn; they act on nothing outside the conversation. */
const CONTROL_TOOLS = ['finish', 'wait', 'wait_5_seconds', 'update_steps'];

/** Native tools whose parameters name files they write. */
const WRITING_TOOLS = new Set<string>([
  ...TOOL_MAP.Write,
  ...TOOL_MAP.Edit,
  ...TOOL_MAP.NotebookEdit,
]);

/**
 * Native tools no Claude tool maps to: agy's own agents, MCP, scheduling, messaging, tasks
 * and media. They belong to the user's agy setup, so they follow Claude's mode like any
 * other tool: Plan leaves them out, and otherwise they run unless an explicit tool list
 * (an agent type's `tools`, or `--tools`) leaves them out.
 */
const UNMAPPED_TOOLS = [
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'browser_subagent',
  'call_mcp_tool',
  'notebook_execution',
  'schedule',
  'manage_task',
  'send_message',
  'manage_inbox',
  'list_resources',
  'read_resource',
  'generate_image',
  'delete_knowledge',
  'run_workflow',
  'search_marketplace',
  'list_plugin_accounts',
  'list_permissions',
  'ask_permission',
  'ask_custom_permission',
  'ask_question',
];

const MCP_TOOL = 'call_mcp_tool';

/** agy's MCP resource tools name a server but no tool, so only server-wide rules match them. */
const MCP_RESOURCE_TOOLS = new Set(['list_resources', 'read_resource']);

export interface AntigravityPolicy {
  /** Native names to deny, plus Claude `mcp__` deny rules checked against each MCP call. */
  denied: string[];
  /**
   * When present, every native tool outside this list is denied, including unknown ones.
   * Claude `mcp__` grants in it admit the MCP calls they match.
   */
  allowed?: string[];
  plan: boolean;
  notice: string;
}

function isMcpRule(rule: string): boolean {
  return rule.startsWith('mcp__');
}

/** This restricts native tools; it never grants permission in place of native policy. */
export function antigravityPermissionPolicy(context: PermissionContext): AntigravityPolicy {
  const native = nativeMode(context.permissionMode);
  const { allowed, denied: disallowed } = nativeRules(context);
  const plan = native.mode === 'plan';
  const denied = new Set<string>([...disallowed].filter(isMcpRule));
  for (const [claudeTool, natives] of Object.entries(TOOL_MAP)) {
    const excluded =
      disallowed.has(claudeTool) ||
      (allowed !== undefined && !allowed.has(claudeTool)) ||
      (plan && PLAN_DENIED_CLAUDE_TOOLS.has(claudeTool));
    if (excluded) {
      for (const native of natives) {
        denied.add(native);
      }
    }
  }
  const notice = [policyNotice(plan), native.notice, context.notice].filter(Boolean).join(' ');
  if (plan) {
    // Plan is an allowlist: a tool agy announces later, or one no Claude tool maps to, is denied.
    const readOnly = PLAN_READ_ONLY.filter((tool) => !denied.has(tool));
    return { denied: [...denied], allowed: [...readOnly, ...CONTROL_TOOLS], plan, notice };
  }
  if (allowed === undefined) {
    return { denied: [...denied], plan, notice };
  }
  // An explicit tool list admits the mapped tools it names and the MCP tools its
  // `mcp__` entries match; agy's other tools have no Claude name to list.
  const mapped = Object.values(TOOL_MAP)
    .flat()
    .filter((tool) => !denied.has(tool));
  const mcpGrants = [...allowed].filter(isMcpRule);
  return {
    denied: [...denied],
    allowed: [...mapped, ...CONTROL_TOOLS, ...mcpGrants],
    plan,
    notice,
  };
}

/** Every native tool this gateway knows. Used for tool-free turns. */
export function antigravityCompactionDenyList(): string[] {
  return [...new Set([...Object.values(TOOL_MAP).flat(), ...UNMAPPED_TOOLS])];
}

function policyNotice(plan: boolean): string {
  if (plan) {
    return 'Plan: only native read, search and web lookup tools run.';
  }
  return "Claude Code rules take precedence; agy's own MCP servers and agents are available. No reviewer.";
}

function toolList(serialized: string): string[] {
  const tools: unknown = JSON.parse(serialized);
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string')) {
    throw new Error('Invalid native tool policy');
  }
  return tools;
}

/** A key naming a file the tool writes (`Path`, `TargetFile`, `file_path`, ...), never its content. */
const PATH_KEY = /(path|file)$/i;

function pathValues(value: unknown, depth = 0): string[] {
  if (depth > 4 || !value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) => {
    if (typeof item !== 'string') {
      return pathValues(item, depth + 1);
    }
    return PATH_KEY.test(key) ? [item] : [];
  });
}

function inside(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
  const relative = lib.relative(fold(parent), fold(child));
  return relative === '' || (!relative.startsWith('..') && !lib.isAbsolute(relative));
}

/**
 * The permission hook lives in agy's user-writable config tree and is read once per turn, so a
 * granted write tool must never target that tree. Shell commands are not path-checked here;
 * Bash is a separate grant.
 */
function targetsProtectedPath(
  call: { name: string; parameters?: unknown },
  options: { protectedRoots: string[]; platform?: NodeJS.Platform; cwd?: string },
): boolean {
  if (!WRITING_TOOLS.has(call.name)) {
    return false;
  }
  const platform = options.platform ?? process.platform;
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const cwd = options.cwd ?? process.cwd();
  return pathValues(call.parameters).some((value) => {
    const expanded = value.startsWith('~') ? `${os.homedir()}${value.slice(1)}` : value;
    const resolved = lib.resolve(cwd, expanded);
    return options.protectedRoots.some((root) => inside(lib.resolve(root), resolved, platform));
  });
}

const SERVER_KEYS = ['ServerName', 'serverName', 'server_name', 'server', 'Server'];
const TOOL_KEYS = ['ToolName', 'toolName', 'tool_name', 'tool', 'Tool', 'name', 'Name'];

function firstString(record: Record<string, unknown>, keys: readonly string[]) {
  const key = keys.find((name) => typeof record[name] === 'string' && record[name] !== '');
  return key === undefined ? undefined : (record[key] as string);
}

const spell = (value: string) => value.replace(/[^\w-]/g, '_');

function mcpServer(parameters: unknown): string | undefined {
  if (!parameters || typeof parameters !== 'object') {
    return undefined;
  }
  const server = firstString(parameters as Record<string, unknown>, SERVER_KEYS);
  return server && spell(server);
}

/** Claude spells an MCP tool `mcp__<server>__<tool>`, with other characters as underscores. */
function claudeMcpName(parameters: unknown): { server: string; tool: string } | undefined {
  const server = mcpServer(parameters);
  const tool =
    parameters && typeof parameters === 'object'
      ? firstString(parameters as Record<string, unknown>, TOOL_KEYS)
      : undefined;
  return server && tool ? { server, tool: spell(tool) } : undefined;
}

/** A resource call is denied by a server-wide `mcp__` rule for its server, or any when unnamed. */
function mcpResourceExcluded(parameters: unknown, denied: string[]): boolean {
  const serverRules = denied.filter(
    (rule) => isMcpRule(rule) && !/^mcp__[\w-]+__(?!\*$)/.test(rule),
  );
  if (!serverRules.length) {
    return false;
  }
  const server = mcpServer(parameters);
  return (
    !server || serverRules.some((rule) => rule === `mcp__${server}` || rule === `mcp__${server}__*`)
  );
}

function matchesMcpRule(rule: string, call: { server: string; tool: string }): boolean {
  const server = `mcp__${call.server}`;
  return rule === server || rule === `${server}__*` || rule === `${server}__${call.tool}`;
}

/**
 * An MCP call runs unless a Claude `mcp__` deny rule matches it, or an allowlist is in force
 * and none of its `mcp__` grants does. A call that names no server cannot be matched, so it is
 * refused only where a rule needs the name.
 */
function mcpCallExcluded(parameters: unknown, denied: string[], allowed?: string[]): boolean {
  const deniedRules = denied.filter(isMcpRule);
  const grants = allowed?.filter(isMcpRule);
  if (grants !== undefined && !grants.length) {
    return true;
  }
  if (grants === undefined && !deniedRules.length) {
    return false;
  }
  const call = claudeMcpName(parameters);
  if (!call || deniedRules.some((rule) => matchesMcpRule(rule, call))) {
    return true;
  }
  return grants !== undefined && !grants.some((rule) => matchesMcpRule(rule, call));
}

function toolArguments(call: object): unknown {
  if ('args' in call && call.args !== undefined) {
    return call.args;
  }
  return 'parameters' in call ? call.parameters : undefined;
}

function excludedByPolicy(
  name: string,
  parameters: unknown,
  denied: string[],
  allowed?: string[],
): boolean {
  if (name === MCP_TOOL) {
    return denied.includes(MCP_TOOL) || mcpCallExcluded(parameters, denied, allowed);
  }
  return (
    denied.includes(name) ||
    (allowed !== undefined && !allowed.includes(name)) ||
    (MCP_RESOURCE_TOOLS.has(name) && mcpResourceExcluded(parameters, denied))
  );
}

function hookCwd(input: object): string | undefined {
  return 'cwd' in input && typeof input.cwd === 'string' ? input.cwd : undefined;
}

/** No policy means an ordinary native CLI session, outside this gateway. */
export function antigravityToolDecision(
  input: unknown,
  serializedPolicy?: string,
  serializedAllowed?: string,
  options: { protectedRoots?: string[] } = {},
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
    // agy sends a call's arguments as `args` (agy 1.5.18); older builds used `parameters`.
    const parameters = toolArguments(call);
    if (excludedByPolicy(call.name, parameters, denied, allowed)) {
      return {
        decision: 'deny',
        reason: 'Claude session policy excludes this native Antigravity tool.',
      };
    }
    const protectedRoots = options.protectedRoots ?? antigravityProtectedRoots();
    // agy runs the hook from its config folder; relative paths belong to the workspace.
    const target = { protectedRoots, cwd: hookCwd(input) };
    if (targetsProtectedPath({ name: call.name, parameters }, target)) {
      return {
        decision: 'deny',
        reason: `Writes to agy's config folder (${protectedRoots.join(', ')}) are refused: Multi's permission hook lives there.`,
      };
    }
    return undefined;
  } catch {
    return { decision: 'deny', reason: 'Antigravity gateway permission context is invalid.' };
  }
}

import os from 'node:os';
import path from 'node:path';
import { nativeToolRules } from '../../multi-core/src/gateway/display-rows.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';

/** Native names reachable from each mapped Claude tool. */
/** The agy config roots that hold hooks and settings; see antigravityProtectedRoots. */
export function antigravityProtectedRoots(
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; homedir?: string } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const roots = [join(home, '.gemini')];
  if (platform === 'win32') {
    roots.push(join(env.LOCALAPPDATA ?? env.APPDATA ?? join(home, 'AppData', 'Local'), 'gemini'));
  }
  return roots;
}

const TOOL_MAP = {
  Read: ['view_file', 'list_dir'],
  Grep: ['grep_search'],
  Glob: ['find_by_name'],
  Bash: ['run_command', 'command_status', 'send_command_input'],
  Write: ['write_to_file'],
  Edit: ['replace_file_content', 'multi_replace_file_content', 'sed_file'],
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
const CONTROL_TOOLS = ['finish', 'wait', 'wait_5_seconds'];

/** Native tools whose parameters name files they write. */
const WRITING_TOOLS = new Set<string>([
  ...TOOL_MAP.Write,
  ...TOOL_MAP.Edit,
  ...TOOL_MAP.NotebookEdit,
]);

/** Native child-agent and MCP tools; agy runs with permissions skipped, so these are always denied. */
const ALWAYS_DENIED = [
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'browser_subagent',
  'call_mcp_tool',
  'notebook_execution',
  // Messaging, scheduling, task and resource tools are child-agent or MCP-like surfaces.
  'schedule',
  'manage_task',
  'send_message',
  'manage_inbox',
  'list_resources',
  'read_resource',
  // No Claude tool maps to these side effects.
  'generate_image',
  'delete_knowledge',
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
  // Always an allowlist: a tool agy announces later, or one no Claude tool maps to, stays denied.
  const mapped = plan ? PLAN_READ_ONLY : Object.values(TOOL_MAP).flat();
  return {
    denied: [...denied],
    allowed: [...mapped.filter((tool) => !denied.has(tool)), ...CONTROL_TOOLS],
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

function stringValues(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (depth > 4 || !value || typeof value !== 'object') {
    return [];
  }
  return Object.values(value).flatMap((item) => stringValues(item, depth + 1));
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
  return stringValues(call.parameters).some((value) => {
    const expanded = value.startsWith('~') ? `${os.homedir()}${value.slice(1)}` : value;
    const resolved = lib.resolve(cwd, expanded);
    return options.protectedRoots.some((root) => inside(lib.resolve(root), resolved, platform));
  });
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
    const parameters = 'parameters' in call ? call.parameters : undefined;
    if (
      denied.includes(call.name) ||
      (allowed && !allowed.includes(call.name)) ||
      targetsProtectedPath(
        { name: call.name, parameters },
        { protectedRoots: options.protectedRoots ?? antigravityProtectedRoots() },
      )
    ) {
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

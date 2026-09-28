import type {
  NativeActionKind,
  NativeActionTracker,
} from '../../multi-core/src/gateway/harness-progress.ts';
import type { HarnessModelCalls } from '../../multi-core/src/gateway/harness-response.ts';
import { type AntigravityStreamEvent, parseAntigravityUsage } from './cli.ts';

type StepUpdate = Extract<AntigravityStreamEvent, { event: 'step_update' }>['step_update'];

/**
 * The toolset `agy` announces in its `init` event, as captured from agy with
 * gemini-3.8-flash (`test/unit/fixtures/antigravity`). The mod registers a display
 * row for each at session start; a CLI that announces more adds them at once.
 */
export const ANTIGRAVITY_TOOLS: readonly string[] = [
  'ask_custom_permission',
  'ask_permission',
  'ask_question',
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
  'browser_subagent',
  'call_mcp_tool',
  'capture_browser_console_logs',
  'capture_browser_screenshot',
  'click_browser_pixel',
  'command_status',
  'define_subagent',
  'delete_knowledge',
  'execute_browser_javascript',
  'find_by_name',
  'finish',
  'generate_image',
  'grep_search',
  'invoke_subagent',
  'list_browser_pages',
  'list_dir',
  'list_permissions',
  'list_resources',
  'manage_inbox',
  'manage_subagents',
  'manage_task',
  'multi_replace_file_content',
  'notebook_edit',
  'notebook_execution',
  'open_browser_url',
  'read_browser_page',
  'read_resource',
  'read_url_content',
  'replace_file_content',
  'run_command',
  'schedule',
  'search_web',
  'sed_file',
  'send_command_input',
  'send_message',
  'view_file',
  'wait',
  'wait_5_seconds',
  'write_to_file',
];

const kinds: Array<[RegExp, NativeActionKind]> = [
  [/grep|search|find|glob/i, 'search'],
  [/edit|write|replace|create|delete|patch|sed/i, 'edit'],
  [/command|shell|terminal|bash|exec/i, 'shell'],
  [/read|view|list|open/i, 'read'],
];
const targetKey = /path|file|command|query|pattern|url/i;
const doneState = /done|complete|success|finish/i;
const failedState = /error|fail|cancel|denied|reject|block/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kindOf(tool: string): NativeActionKind {
  return kinds.find(([pattern]) => pattern.test(tool))?.[1] ?? 'other';
}

/** The native parameters `agy` reports for a step (`tool_info.parameters`). */
function parameters(info: Record<string, unknown> | undefined): Record<string, unknown> {
  if (isRecord(info?.parameters)) {
    return info.parameters;
  }
  const { name: _name, output: _output, ...rest } = info ?? {};
  return rest;
}

/** The first path, command or query among the parameters, if any. */
function target(input: Record<string, unknown>) {
  for (const [key, value] of Object.entries(input)) {
    if (targetKey.test(key) && typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

/** The native output `agy` reports for a finished step (`tool_info.output`). */
function output(info: Record<string, unknown> | undefined): string | undefined {
  const value = info?.output;
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Reports the toolset `agy` announced in its `init` event. */
export function observeAntigravityInit(init: { tools?: unknown }, tracker: NativeActionTracker) {
  if (Array.isArray(init.tools)) {
    tracker.toolset(init.tools.filter((tool): tool is string => typeof tool === 'string'));
  }
}

/**
 * Reports one `agy` tool step: its native tool name and parameters when it
 * starts, and its native output when it ends. A step is keyed by its index, so
 * repeated updates for the same step settle it rather than adding actions; a
 * step whose state never reports an end is settled with its run.
 *
 * `agy` does not distinguish a failed tool step: the captured failing command
 * (`cat /nonexistent/file`) ends `state: "DONE"`, its error only in
 * `tool_info.output`, with no exit code or error field. Such a step is reported
 * done with that output attached, never guessed at from the output's text; the
 * row's result shows the output, so the person sees the error.
 */
export function observeAntigravityStep(
  update: StepUpdate,
  tracker: NativeActionTracker,
  fallbackId: () => string,
) {
  if (typeof update.tool_name !== 'string' || !update.tool_name) {
    return;
  }
  const id = typeof update.step_index === 'number' ? `step-${update.step_index}` : fallbackId();
  const kind = kindOf(update.tool_name);
  const input = parameters(update.tool_info);
  const subject = target(input);
  tracker.start(id, {
    kind,
    tool: update.tool_name,
    input,
    description: subject ? `${update.tool_name}: ${subject}` : update.tool_name,
    ...(kind === 'edit' && subject ? { changed: subject } : {}),
  });
  const state = typeof update.state === 'string' ? update.state : '';
  const result = output(update.tool_info);
  if (failedState.test(state)) {
    tracker.finish(id, { outcome: state.toLowerCase(), output: result ?? state, error: true });
  } else if (doneState.test(state)) {
    const seconds = update.duration_seconds;
    tracker.finish(id, {
      outcome: typeof seconds === 'number' ? `done · ${seconds}s` : 'done',
      ...(result === undefined ? {} : { output: result }),
      error: false,
    });
  }
}

/**
 * Records one model call. agy reports each as an `agent_response` step whose
 * final update carries that call's own usage, before the turn's `result`, whose
 * usage is every call summed (`test/unit/fixtures/antigravity/calls-*.jsonl`).
 * The streamed text updates of the same step carry no usage and are not calls.
 */
export function observeAntigravityCall(update: StepUpdate, calls: HarnessModelCalls) {
  if (update.step_type !== 'agent_response') {
    return;
  }
  const usage = parseAntigravityUsage(update.usage);
  if (usage?.input_tokens === undefined) {
    return;
  }
  calls.record(
    {
      input: usage.input_tokens,
      ...(usage.output_tokens === undefined ? {} : { output: usage.output_tokens }),
      ...(usage.cache_read_tokens === undefined ? {} : { cacheRead: usage.cache_read_tokens }),
    },
    typeof update.step_index === 'number' ? `step-${update.step_index}` : undefined,
  );
}

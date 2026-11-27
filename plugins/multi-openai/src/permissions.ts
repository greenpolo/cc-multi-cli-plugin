import { nativeMode, nativeRules } from '../../multi-core/src/gateway/harness-settings.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';
import type { CodexRunOptions, CodexSandbox } from './app-server.ts';

/**
 * How one Codex turn runs. Codex never asks for approval (`approvalPolicy: never`) and runs
 * no reviewer: Plan is its read-only sandbox, every other Claude mode is full access, as
 * Claude's Bypass is. Claude's explicit restrictions map where Codex has a switch for them.
 */
export interface CodexPolicy {
  sandbox: CodexSandbox;
  config: Record<string, unknown>;
  mcpOff?: CodexRunOptions['mcpOff'];
  /** Said only where the run differs from Claude's own behaviour. */
  notice?: string;
}

/** `mcp__server`, `mcp__server__*` or `mcp__server__tool`, split into its server and tool. */
function mcpRule(rule: string): { server: string; tool?: string } | undefined {
  const match = /^mcp__([\w-]+?)(?:__([\w*-]+))?$/.exec(rule);
  if (!match) {
    return undefined;
  }
  const [, server, tool] = match;
  return tool && tool !== '*' ? { server, tool } : { server };
}

/** Which Codex MCP servers and tools Claude's deny rules and tool list leave out. */
function mcpPolicy(context: PermissionContext): CodexRunOptions['mcpOff'] {
  const { allowed, denied } = nativeRules(context);
  if (allowed !== undefined && ![...allowed].some((tool) => tool.startsWith('mcp__'))) {
    return { all: true };
  }
  const servers: string[] = [];
  const tools: Record<string, string[]> = {};
  for (const rule of denied) {
    const parsed = mcpRule(rule);
    if (!parsed) {
      continue;
    }
    if (parsed.tool) {
      tools[parsed.server] = [...(tools[parsed.server] ?? []), parsed.tool];
    } else {
      servers.push(parsed.server);
    }
  }
  return servers.length || Object.keys(tools).length ? { servers, tools } : undefined;
}

/** Claude's tool list and deny rules as Codex can carry them, and what it cannot. */
function toolPolicy(context: PermissionContext) {
  const { allowed, denied } = nativeRules(context);
  const unavailable = (tool: string) =>
    denied.has(tool) || (allowed !== undefined && !allowed.has(tool));
  const skipped: string[] = [];
  // Codex edits files with one patch tool; only the sandbox can take it away.
  const editsOff = unavailable('Edit') && unavailable('Write');
  if (!editsOff && (unavailable('Edit') || unavailable('Write'))) {
    skipped.push(unavailable('Edit') ? 'Edit' : 'Write');
  }
  // Codex always has its shell; without edits it is at least read-only.
  if (unavailable('Bash')) {
    skipped.push('Bash');
  }
  const config: Record<string, unknown> = unavailable('WebSearch')
    ? { web_search: 'disabled' }
    : {};
  return { editsOff, skipped, config };
}

/** This restricts Codex; it never grants anything Codex's own settings refuse. */
export function codexPermissionPolicy(context: PermissionContext): CodexPolicy {
  const plan = nativeMode(context.permissionMode).mode === 'plan';
  if (plan) {
    return {
      sandbox: 'read-only',
      config: toolPolicy(context).config,
      mcpOff: { all: true },
      notice: joined('Plan: Codex runs read-only, with its MCP servers off.', context.notice),
    };
  }
  const tools = toolPolicy(context);
  const notices = [
    tools.editsOff ? 'Codex runs read-only because Claude removed Edit and Write.' : undefined,
    tools.skipped.length
      ? `Codex has no separate switch for ${tools.skipped.join(' or ')}, so it stays available.`
      : undefined,
    context.notice,
  ];
  const mcpOff = mcpPolicy(context);
  return {
    sandbox: tools.editsOff ? 'read-only' : 'danger-full-access',
    config: tools.config,
    ...(mcpOff ? { mcpOff } : {}),
    notice: joined(...notices),
  };
}

/** A summary turn reads the conversation only: no writes, no MCP. */
export function codexCompactionPolicy(): CodexPolicy {
  return {
    sandbox: 'read-only',
    config: {},
    mcpOff: { all: true },
    notice: 'Compaction summary; Codex runs read-only.',
  };
}

function joined(...notices: (string | undefined)[]): string | undefined {
  return notices.filter(Boolean).join(' ') || undefined;
}

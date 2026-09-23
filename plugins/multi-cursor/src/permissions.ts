import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentModeOption, AgentOptions } from '@cursor/sdk';
import type { WorkerPermissions } from '../../multi-core/src/gateway/agent-definitions.ts';
import { nativeToolRules } from '../../multi-core/src/gateway/display-rows.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';

export const TOOL_CAPABILITIES = [
  ['shell', ['Bash']],
  ['read', ['Read']],
  ['edit', ['Edit', 'Write']],
  ['grep', ['Grep']],
  ['glob', ['Glob']],
  ['ls', ['Read']],
] as const;

/** A prompt-time policy; reapply tools on SDK resume because they are not persisted. */
export function cursorPermissionPolicy(context: PermissionContext): {
  mode: AgentModeOption;
  tools: NonNullable<AgentOptions['tools']>;
  identity: string;
  autoReview: boolean;
} {
  if (context.nativePermissionError) {
    throw new Error(context.nativePermissionError);
  }
  const mode = cursorPermissionMode(context.permissionMode);
  const allowed = claudeToolRules(context.tools);
  const denied = claudeToolRules(context.disallowedTools);
  const tools = TOOL_CAPABILITIES.filter(([tool, names]) => {
    if (mode === 'plan' && (tool === 'shell' || tool === 'edit')) {
      return false;
    }
    return names.every((name) => (!allowed || allowed.has(name)) && !denied?.has(name));
  }).map(([tool]) => tool);
  const autoReview = context.permissionMode !== 'bypassPermissions';
  return { mode, tools, autoReview, identity: JSON.stringify([mode, tools, autoReview]) };
}

function claudeToolRules(value: string[] | undefined): Set<string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  // A display-row grant (`mcp__multi-core`) draws Claude Code rows; it maps to no native tool.
  const rules = nativeToolRules(value) ?? [];
  const supported = new Set<string>(TOOL_CAPABILITIES.flatMap(([, names]) => [...names]));
  // These capabilities are always absent: recognizing their restrictions cannot enable them.
  supported.add('Agent');
  supported.add('Task');
  for (const rule of rules) {
    if (!supported.has(rule)) {
      throw new Error(`Native Cursor cannot enforce Claude tool rule ${rule}; unsupported policy.`);
    }
  }
  return new Set(rules);
}

/** Native permissions belong to Cursor. Never replace its sandbox configuration. */
export async function cursorNativePermissions(
  cwd: string,
  context: PermissionContext = { permissionMode: 'auto' },
): Promise<Pick<AgentOptions, 'tools' | 'agents' | 'mcpServers' | 'local'>> {
  const policy = cursorPermissionPolicy(context);
  if (!path.isAbsolute(cwd)) {
    throw new Error('Native Cursor requires an absolute workspace path');
  }
  const workspace = await realpath(cwd);
  const roots = new Set([os.homedir()]);
  for (let directory = workspace; ; directory = path.dirname(directory)) {
    roots.add(directory);
    if (directory === path.dirname(directory)) {
      break;
    }
  }
  // Isolated SDK settings never load a user's .cursor policy. A permissions.json
  // is a deny list, so refuse rather than silently drop it. A hooks.json is
  // observability (Orca and similar) and is simply not run for gateway sessions.
  for (const directory of roots) {
    await rejectIgnoredPolicy(path.join(directory, '.cursor', 'permissions.json'));
  }
  return {
    tools: policy.tools,
    agents: {},
    mcpServers: {},
    local: {
      cwd: workspace,
      // Loading public hook sources also bootstraps ambient MCP servers. Until
      // the SDK separates them, refuse ignored policies instead of dropping them.
      settingSources: [],
      // This requests native review, not a fail-closed availability guarantee.
      // The SDK documents unrestricted fallback when its classifier is unavailable.
      autoReview: policy.autoReview,
      enableAgentRetries: false,
    },
  };
}

async function rejectIgnoredPolicy(file: string): Promise<void> {
  try {
    await lstat(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error(
    `Native Cursor cannot honor ${file} with isolated SDK settings. This permission configuration is unsupported.`,
  );
}

/** Claude cannot enforce these restrictions over tools executed by Cursor. */
export function assertCursorClaudeSettings(
  settings: unknown,
  { cursorToolRules = true }: { cursorToolRules?: boolean } = {},
): WorkerPermissions {
  const value = settingsRecord(settings);
  if (value.disableAllHooks === true) {
    throw new Error('Native Cursor requires Claude mode hooks; disableAllHooks is unsupported.');
  }
  const permissions = settingsRecord(value.permissions ?? {});
  assertNativeAskRules(permissions.ask);
  const denied = permissions.deny;
  if (
    denied !== undefined &&
    (!Array.isArray(denied) || denied.some((rule) => typeof rule !== 'string'))
  ) {
    throw new Error('Native Cursor cannot enforce Claude permissions.deny');
  }
  // Another harness validates the merged rules itself once every source is read, so a
  // per-file Cursor check would reject rules that harness does enforce.
  if (cursorToolRules) {
    claudeToolRules(denied);
  }
  // Claude's PreToolUse/PermissionRequest hooks never run for native Cursor tools.
  // They are not translatable policy, so they neither block admission nor apply.
  const sandbox = settingsRecord(value.sandbox ?? {});
  if (Object.keys(sandbox).some((key) => key !== 'enabled' || sandbox.enabled !== false)) {
    throw new Error(
      'Native Cursor cannot enforce Claude sandbox settings; native execution is unavailable.',
    );
  }
  return { disallowedTools: denied };
}

/** Restriction layers intersect grants and accumulate denials; none can widen another. */
export function mergeCursorPermissions(
  context: PermissionContext,
  rules: WorkerPermissions = {},
): PermissionContext {
  let tools = context.tools;
  if (rules.tools !== undefined) {
    tools = tools === undefined ? rules.tools : tools.filter((tool) => rules.tools?.includes(tool));
  }
  return {
    ...context,
    tools,
    disallowedTools: [...(context.disallowedTools ?? []), ...(rules.disallowedTools ?? [])],
  };
}

function settingsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Claude settings for native Cursor execution');
  }
  return value as Record<string, unknown>;
}

function assertNativeAskRules(value: unknown): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.length > 0 || value.some((rule) => typeof rule !== 'string'))
  ) {
    throw new Error(
      'Native Cursor cannot enforce Claude permissions.ask; native execution is unavailable.',
    );
  }
}

/** The policy helper also removes write-capable tools for Plan. */
export function cursorPermissionMode(value: unknown): AgentModeOption {
  if (value === 'auto' || value === 'bypassPermissions') {
    return 'agent';
  }
  if (value === 'plan') {
    return 'plan';
  }
  throw new Error(
    'Native Cursor supports only Claude auto, plan or bypassPermissions permission mode; the selected mode is unsupported.',
  );
}

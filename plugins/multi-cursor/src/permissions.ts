import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AgentModeOption, AgentOptions } from '@cursor/sdk';
import { nativeMode, nativeRules } from '../../multi-core/src/gateway/harness-settings.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';

const TOOL_CAPABILITIES = [
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
  notice?: string;
} {
  const native = nativeMode(context.permissionMode);
  const mode: AgentModeOption = native.mode === 'plan' ? 'plan' : 'agent';
  const { allowed, denied } = nativeRules(context);
  const tools = TOOL_CAPABILITIES.filter(([tool, names]) => {
    if (mode === 'plan' && (tool === 'shell' || tool === 'edit')) {
      return false;
    }
    return names.every((name) => (!allowed || allowed.has(name)) && !denied.has(name));
  }).map(([tool]) => tool);
  const autoReview = native.mode !== 'bypassPermissions';
  const notice = [native.notice, context.notice].filter(Boolean).join(' ') || undefined;
  return { mode, tools, autoReview, notice, identity: JSON.stringify([mode, tools, autoReview]) };
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
  return {
    tools: policy.tools,
    agents: {},
    mcpServers: {},
    local: {
      cwd: workspace,
      // Loading public hook sources also bootstraps ambient MCP servers, so the SDK
      // settings stay isolated; a user's .cursor policy files are not loaded.
      settingSources: [],
      // This requests native review, not a fail-closed availability guarantee.
      // The SDK documents unrestricted fallback when its classifier is unavailable.
      autoReview: policy.autoReview,
      enableAgentRetries: false,
    },
  };
}

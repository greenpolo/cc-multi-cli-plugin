// The environment the launched Claude Code runs in: the gateway's address and token, and a
// `claude` on PATH that nested runs can use without them.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nestedClaudeShim, withPathPrefix } from '../gateway/nested-env.ts';
import { needsEnvProxy, rememberOriginalEnvironment, withoutGateway } from '../install/process.ts';

/**
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also blocks the plugin worker's loopback call
 * to this gateway, which the Mods control plane requires (an end-to-end check on
 * Claude Code 2.1.283 showed the broad flag blocks the function-hook fetch while the
 * narrow flags do not). Keep the user's intent (no updater, telemetry, error reports or
 * feedback command) with the narrower flags instead of silently running without the mod.
 *
 * This is not about GrowthBook. The broad flag and DISABLE_TELEMETRY both turn it off,
 * and on Claude Code 2.1.287 the Mods rollout flag `tengu_plugin_hooks_modules` defaults
 * to on without it, so the replacement flags leave the mod loading.
 */
function translateTrafficPolicy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined) {
    return env;
  }
  const { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _flag, ...rest } = env;
  process.stderr.write(
    'Multi: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC would block the local gateway; using DISABLE_AUTOUPDATER, DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING, DISABLE_BUG_COMMAND and DISABLE_FEEDBACK_COMMAND instead.\n',
  );
  return {
    ...rest,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_BUG_COMMAND: '1',
    DISABLE_FEEDBACK_COMMAND: '1',
  };
}

export function gatewayEnvironment(port: number, token: string, anthropic: boolean) {
  // A launch inside another Multi session starts from the user's own environment.
  const origin = withoutGateway(process.env);
  const env = translateTrafficPolicy({ ...origin });
  delete env.OPENCODE_API_KEY;
  return {
    ...env,
    // What nested Claude runs get back in place of the gateway (see nested-env.ts).
    ...rememberOriginalEnvironment(origin),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    // A custom base URL makes Claude Code skip on-demand tool loading unless it is told
    // otherwise, and a gateway base URL is always custom. Claude's own default against
    // Anthropic is to defer tools always, which is what 'true' says; the user's own
    // setting is kept. 'auto' would instead load every tool once a 1M window makes them
    // under 10%.
    ENABLE_TOOL_SEARCH: origin.ENABLE_TOOL_SEARCH ?? 'true',
    MULTI_GATEWAY_TOKEN: token,
    // Claude Code 2.1.287 and newer has Mods on by default; 2.1.272 to 2.1.286 need this.
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    MULTI_MOD_GATEWAY_URL: `http://127.0.0.1:${port}`,
    ...(!anthropic ? { ANTHROPIC_AUTH_TOKEN: token } : {}),
    ANTHROPIC_CUSTOM_HEADERS: [origin.ANTHROPIC_CUSTOM_HEADERS, `x-multi-gateway-token: ${token}`]
      .filter(Boolean)
      .join('\n'),
  };
}

/**
 * A `claude` run by Claude's own tools (Bash `claude -p`, scripts) inherits the session's
 * gateway environment and would route through a gateway that is not its own. Put a
 * `claude` on the session's PATH that runs the real executable without it.
 */
export async function withNestedClaudeShim(
  env: NodeJS.ProcessEnv,
  settingsDir: string,
  claude: string,
): Promise<NodeJS.ProcessEnv> {
  const directory = path.join(settingsDir, 'bin');
  const shim = nestedClaudeShim({
    node: process.execPath,
    script: fileURLToPath(new URL('../install/nested-claude.ts', import.meta.url)),
    claude,
  });
  await mkdir(directory, { recursive: true });
  for (const file of shim.files) {
    await writeFile(path.join(directory, file.file), file.content, { mode: 0o755 });
  }
  return withPathPrefix(env, directory);
}

/** A proxy the user has configured is honored only if Node was started to use it. */
export function warnIfProxyUnused() {
  if (needsEnvProxy(process.env)) {
    process.stderr.write(
      'Multi: HTTP_PROXY/HTTPS_PROXY is set but Node ignores it for the gateway; start the launcher with NODE_USE_ENV_PROXY=1 (the installed command does).\n',
    );
  }
}

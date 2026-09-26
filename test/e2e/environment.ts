import os from 'node:os';
import path from 'node:path';
import type { Scenario } from './types.ts';

function inherited(name: string): string | undefined {
  const entry = Object.entries(process.env).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1];
}

export function scenarioEnvironment(
  root: string,
  bin: string,
  proxy: string,
  upstream: string,
  scenario: Scenario,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG']) {
    const value = inherited(name);
    if (value) {
      env[name] = value;
    }
  }
  // Emit only one PATH spelling; Node sorts duplicate Windows env keys.
  env.PATH = `${bin}${path.delimiter}${inherited('PATH') ?? ''}`;
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    APPDATA: root,
    LOCALAPPDATA: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
    CLAUDE_CONFIG_DIR: path.join(root, 'config'),
    CODEX_HOME: path.join(root, 'codex'),
    ANTHROPIC_API_KEY: 'e2e-dummy-anthropic',
    OPENCODE_API_KEY: 'e2e-dummy-zen',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_BUG_COMMAND: '1',
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: '127.0.0.1,localhost',
    MULTI_ENABLED_PROVIDERS: (scenario.enabledProviders ?? []).join(','),
    MULTI_NATIVE_TRACE: '1',
    MULTI_E2E_UPSTREAM: upstream,
    MULTI_REAL_CLAUDE:
      process.env.MULTI_E2E_CLAUDE ??
      path.join(
        os.homedir(),
        '.local',
        'bin',
        process.platform === 'win32' ? 'claude.exe' : 'claude',
      ),
    MULTI_ANTIGRAVITY: scenario.native?.agy ? '1' : '0',
    MULTI_GROK: scenario.native?.grok ? '1' : '0',
  });
  if (scenario.gatewayTimeoutMs !== undefined) {
    env.MULTI_E2E_GATEWAY_TIMEOUT_MS = String(scenario.gatewayTimeoutMs);
  }
  if (scenario.cursorModule) {
    env.MULTI_E2E_CURSOR_MODULE = scenario.cursorModule;
  }
  if (scenario.direct) {
    env.ANTHROPIC_BASE_URL = `${upstream}/anthropic`;
  }
  return { ...env, ...scenario.env };
}

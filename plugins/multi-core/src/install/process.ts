import { spawn } from 'node:child_process';
import { executableInvocation, UnsafeCommandArgumentError } from '../gateway/executable.ts';
import { terminateProcessTree } from '../gateway/process-tree.ts';

export interface RunOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Shell-free foreground process, including cancellation and exit status. */
export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<number> {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const invocation = executableInvocation(command, args, platform, environment);
  const child = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    env: environment,
    detached: platform !== 'win32',
    ...invocation.options,
  });
  const terminate = () => {
    if (child.pid) {
      terminateProcessTree(child.pid, { platform });
    }
  };
  const interrupt = () => {}; // The foreground terminal signals both processes on Unix.
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
  } finally {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interrupt);
  }
}

/** What the session started with, kept so a nested run can be given it back. */
const RESTORABLE = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS'] as const;
const ORIGINAL_PREFIX = 'MULTI_ORIG_';

/** Remember the caller's own values before the launcher replaces them. */
export function rememberOriginalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const remembered: NodeJS.ProcessEnv = {};
  for (const name of RESTORABLE) {
    const value = env[name];
    if (value !== undefined) {
      remembered[`${ORIGINAL_PREFIX}${name}`] = value;
    }
  }
  return remembered;
}

/**
 * The environment for a Claude run that is not the Multi session: no gateway URL, no
 * gateway token, no gateway credential, and the caller's own base URL and headers
 * back. An environment that carries no gateway token is returned unchanged.
 */
export function withoutGateway(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const token = env.MULTI_GATEWAY_TOKEN;
  if (token === undefined) {
    return env;
  }
  const result: NodeJS.ProcessEnv = { ...env };
  delete result.MULTI_GATEWAY_TOKEN;
  delete result.MULTI_MOD_GATEWAY_URL;
  if (result.ANTHROPIC_AUTH_TOKEN === token) {
    delete result.ANTHROPIC_AUTH_TOKEN;
  }
  for (const name of RESTORABLE) {
    const original = env[`${ORIGINAL_PREFIX}${name}`];
    delete result[`${ORIGINAL_PREFIX}${name}`];
    if (original === undefined) {
      delete result[name];
    } else {
      result[name] = original;
    }
  }
  return result;
}

/**
 * Node's fetch ignores HTTP_PROXY and HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set
 * when the process starts; setting it later has no effect. A user who needs a proxy to
 * reach Anthropic or a provider has it for Claude Code itself, so the gateway has to
 * honor it too. True when the process is configured for a proxy but not yet using it.
 */
export function needsEnvProxy(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_USE_ENV_PROXY === undefined &&
    ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((name) => Boolean(env[name]))
  );
}

/** The message a failed `run` is reported with; a refused argument is named and explained. */
export function describeRunError(error: unknown): string {
  if (error instanceof UnsafeCommandArgumentError) {
    const shown = error.argument.length > 80 ? `${error.argument.slice(0, 80)}...` : error.argument;
    return `Claude is launched through a .cmd/.bat file, and cmd.exe cannot pass the argument ${JSON.stringify(shown)} safely (it contains one of " % ! ^ & | < > or a line break). Run Claude through the npm-installed claude (npm install -g @anthropic-ai/claude-code) or the native installer, or avoid those characters in the argument.`;
  }
  return error instanceof Error ? error.message : String(error);
}

const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/**
 * With a proxy configured and NODE_USE_ENV_PROXY=1, the gateway's and hooks' own
 * requests to 127.0.0.1 would go through the proxy too. Append the loopback names to
 * NO_PROXY and no_proxy, keeping the user's entries and adding none twice.
 */
export function withLoopbackNoProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!PROXY_VARIABLES.some((name) => Boolean(env[name]))) {
    return env;
  }
  const result: NodeJS.ProcessEnv = { ...env };
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const entries = (env[name] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const missing = LOOPBACK_HOSTS.filter((host) => !entries.includes(host));
    result[name] = [...entries, ...missing].join(',');
  }
  return result;
}

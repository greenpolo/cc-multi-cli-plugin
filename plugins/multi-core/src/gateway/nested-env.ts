// ---------------------------------------------------------------------------
// A Multi session points Claude Code at its own gateway through environment
// variables. Every process Claude starts inherits them, including a `claude -p`
// run by an agent's Bash tool, an SDK run, or a script. Those runs are not part
// of the session; once the session exits the gateway is gone, and until then
// they would route through (and inherit the credentials of) a gateway that was
// not started for them. A nested run gets the environment the session started
// with instead (`withoutGateway`, in install/process.ts: the installed bootstrap
// has to carry it without the rest of the gateway).
// ---------------------------------------------------------------------------

export interface NestedShimFile {
  file: string;
  content: string;
}

/**
 * The `claude` launchers a session puts first on PATH for the processes it starts. On
 * Windows that is `claude.cmd` for cmd.exe and PowerShell, plus an extensionless sh
 * script: Claude Code's Bash tool there is Git Bash, which does not apply PATHEXT and
 * would otherwise find npm's own extensionless `claude`.
 */
export function nestedClaudeShim(options: {
  platform?: NodeJS.Platform;
  node: string;
  script: string;
  claude: string;
}): NestedShimFile & { files: NestedShimFile[] } {
  const { node, script, claude } = options;
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const sh: NestedShimFile = {
    file: 'claude',
    content: `#!/bin/sh\nexec ${quote(node)} ${quote(script)} ${quote(claude)} "$@"\n`,
  };
  if ((options.platform ?? process.platform) === 'win32') {
    const cmd: NestedShimFile = {
      file: 'claude.cmd',
      content: `@echo off\r\n"${node}" "${script}" "${claude}" %*\r\n`,
    };
    return { ...cmd, files: [cmd, sh] };
  }
  return { ...sh, files: [sh] };
}

/** `directory` first on PATH, whatever case the platform spells the variable in. */
export function withPathPrefix(
  env: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const name = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const delimiter = platform === 'win32' ? ';' : ':';
  const existing = env[name];
  return { ...env, [name]: existing ? `${directory}${delimiter}${existing}` : directory };
}

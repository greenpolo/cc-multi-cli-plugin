import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const WINDOWS_BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);
const WINDOWS_DIRECT_EXTENSIONS = new Set([".com", ".exe"]);
const windowsCommandCache = new Map();

export function runCommand(command, args = [], options = {}) {
  const resolved = resolveSpawnCommand(command, options.env);
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    windowsHide: true
  };

  const result = resolved.shellCommand
    ? spawnSync(buildWindowsShellCommand(resolved.command, args), {
        ...spawnOptions,
        shell: true
      })
    : spawnSync(resolved.command, args, spawnOptions);

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function spawnCommand(command, args = [], options = {}) {
  const resolved = resolveSpawnCommand(command, options.env);
  return resolved.shellCommand
    ? spawn(buildWindowsShellCommand(resolved.command, args), {
        ...options,
        shell: true
      })
    : spawn(resolved.command, args, options);
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

function resolveSpawnCommand(command, env = process.env) {
  if (process.platform !== "win32") {
    return { command, shellCommand: false };
  }

  const directResolution = resolveWindowsCommand(command, env);
  return {
    command: directResolution.command,
    shellCommand: WINDOWS_BATCH_EXTENSIONS.has(directResolution.extension)
  };
}

function resolveWindowsCommand(command, env = process.env) {
  const normalized = String(command);
  const explicitExtension = getWindowsExtension(normalized);
  if (normalized.includes("/") || normalized.includes("\\")) {
    return { command: normalized.replace(/\\/g, "/"), extension: explicitExtension };
  }

  const cacheKey = `${env?.PATH ?? process.env.PATH ?? ""}\0${normalized.toLowerCase()}`;
  const cached = windowsCommandCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const found = spawnSync("where.exe", [normalized], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true
  });
  const matches = found.status === 0
    ? found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  const direct = matches.find((match) => WINDOWS_DIRECT_EXTENSIONS.has(getWindowsExtension(match)));
  const batch = matches.find((match) => WINDOWS_BATCH_EXTENSIONS.has(getWindowsExtension(match)));
  const resolved = direct ?? batch ?? normalized;
  const result = { command: resolved.replace(/\\/g, "/"), extension: getWindowsExtension(resolved) };
  windowsCommandCache.set(cacheKey, result);
  return result;
}

function getWindowsExtension(command) {
  const match = String(command).match(/\.([^.\\/]+)$/);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function buildWindowsShellCommand(command, args) {
  return [command, ...args].map(quoteWindowsShellArg).join(" ");
}

function quoteWindowsShellArg(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new Error("Cannot safely pass newline-containing arguments through cmd.exe.");
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

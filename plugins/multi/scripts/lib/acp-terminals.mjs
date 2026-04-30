/**
 * ACP terminal services. Implements the client-side `terminal/*` methods that
 * agents (notably Cursor in /debug mode) use to run shell commands via the
 * Agent Client Protocol.
 *
 * We declare `clientCapabilities.terminal = true` in the handshake; the agent
 * then sends `terminal/create` (and friends) as JSON-RPC requests. Without
 * this, Cursor's "Terminal" tool sticks in `in_progress` forever and the
 * surrounding session/prompt never returns.
 *
 * Outputs are captured into a per-terminal ring buffer up to `outputByteLimit`
 * (default 1 MiB). Exit status is recorded once the child exits, so subsequent
 * terminal/output and terminal/wait_for_exit calls return promptly.
 */

import { spawn } from "node:child_process";

const DEFAULT_OUTPUT_BYTE_LIMIT = 1 << 20; // 1 MiB

let nextTerminalId = 1;

/**
 * Registry of active terminals. One instance per ACP client.
 */
export class TerminalRegistry {
  constructor() {
    /** @type {Map<string, TerminalEntry>} */
    this.terminals = new Map();
  }

  create(params) {
    if (!params?.command) {
      throw { code: -32602, message: "terminal/create: missing command" };
    }
    const terminalId = `term_${nextTerminalId++}`;
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : process.cwd();
    const envOverrides = Array.isArray(params.env)
      ? Object.fromEntries(params.env.filter((e) => e?.name).map((e) => [String(e.name), String(e.value ?? "")]))
      : {};
    const env = { ...process.env, ...envOverrides };
    const outputByteLimit = Number.isFinite(params.outputByteLimit) && params.outputByteLimit > 0
      ? Number(params.outputByteLimit)
      : DEFAULT_OUTPUT_BYTE_LIMIT;

    const entry = new TerminalEntry({
      command: String(params.command),
      args,
      cwd,
      env,
      outputByteLimit
    });
    this.terminals.set(terminalId, entry);
    return { terminalId };
  }

  output(params) {
    const entry = this._get(params);
    return entry.snapshot();
  }

  async waitForExit(params) {
    const entry = this._get(params);
    const status = await entry.waitForExit();
    return status;
  }

  kill(params) {
    const entry = this._get(params);
    entry.kill();
    return {};
  }

  release(params) {
    const entry = this._get(params, /*allowMissing*/ true);
    if (entry) {
      entry.kill();
      this.terminals.delete(params.terminalId);
    }
    return {};
  }

  releaseAll() {
    for (const [, entry] of this.terminals) {
      try {
        entry.kill();
      } catch {
        // Best-effort.
      }
    }
    this.terminals.clear();
  }

  _get(params, allowMissing = false) {
    const id = params?.terminalId;
    const entry = id ? this.terminals.get(id) : null;
    if (!entry && !allowMissing) {
      throw { code: -32602, message: `Unknown terminalId: ${id ?? "<missing>"}` };
    }
    return entry;
  }
}

class TerminalEntry {
  constructor({ command, args, cwd, env, outputByteLimit }) {
    this.outputByteLimit = outputByteLimit;
    this.outputBuffer = "";
    this.truncated = false;
    /** @type {{ exitCode: number | null, signal: string | null } | null} */
    this.exitStatus = null;
    /** @type {Array<(status: any) => void>} */
    this.exitWaiters = [];

    // The ACP terminal is intentionally shell-backed so agents can run commands
    // like `npm test`; when args are supplied, quote them into one command line
    // instead of combining shell:true with a spawn args array.
    const commandLine = buildShellCommand(command, args);
    this.child = spawn(commandLine, {
      cwd,
      env,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const append = (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const room = this.outputByteLimit - this.outputBuffer.length;
      if (room <= 0) {
        this.truncated = true;
        return;
      }
      if (text.length > room) {
        this.outputBuffer += text.slice(0, room);
        this.truncated = true;
      } else {
        this.outputBuffer += text;
      }
    };

    this.child.stdout?.on("data", append);
    this.child.stderr?.on("data", append);

    this.child.once("error", (err) => {
      append(`\n[terminal error] ${err?.message ?? err}\n`);
      if (!this.exitStatus) {
        this.exitStatus = { exitCode: null, signal: null };
        for (const w of this.exitWaiters) w(this.exitStatus);
        this.exitWaiters = [];
      }
    });

    this.child.once("exit", (code, signal) => {
      this.exitStatus = { exitCode: typeof code === "number" ? code : null, signal: signal ?? null };
      for (const w of this.exitWaiters) w(this.exitStatus);
      this.exitWaiters = [];
    });
  }

  snapshot() {
    return {
      output: this.outputBuffer,
      truncated: this.truncated,
      exitStatus: this.exitStatus ?? undefined
    };
  }

  waitForExit() {
    if (this.exitStatus) {
      return Promise.resolve(this.exitStatus);
    }
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  kill() {
    if (this.child && !this.child.killed && this.exitStatus == null) {
      try {
        this.child.kill();
      } catch {
        // Best-effort.
      }
    }
  }
}

function buildShellCommand(command, args) {
  if (args.length === 0) {
    return command;
  }
  const quote = process.platform === "win32" ? quoteWindowsShellArg : quotePosixShellArg;
  return `${command} ${args.map(quote).join(" ")}`;
}

function quotePosixShellArg(value) {
  const text = String(value);
  if (text === "") {
    return "''";
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function quoteWindowsShellArg(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new Error("Cannot safely pass newline-containing arguments through cmd.exe.");
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

/**
 * ACP (Agent Client Protocol) JSON-RPC client for communicating with `gemini --acp`.
 *
 * Three classes:
 * - AcpClientBase: Shared JSON-RPC logic (request/response matching, notifications, line parsing)
 * - SpawnedAcpClient: Spawns `gemini --acp` as a child process (direct mode)
 * - BrokerAcpClient: Connects to broker via Unix socket
 *
 * Factory:
 * - GeminiAcpClient.connect(): Tries broker first, falls back to direct spawn
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, execSync } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./gemini-broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";
import { TerminalRegistry } from "./acp-terminals.mjs";
import { attachStderrDiagnosticCollector, BROKER_DIAGNOSTIC_METHOD, sanitizeDiagnosticMessage } from "./acp-diagnostics.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "GEMINI_COMPANION_ACP_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

// Maximum retained size (in characters) of the in-progress line buffer. Guards
// against memory growth from a peer that never emits a newline. Full ACP
// messages are line-delimited and normally well under 1 MiB.
export const ACP_MAX_LINE_BUFFER = 1 << 20;

/**
 * @typedef {import("./acp-protocol").JsonRpcRequest} JsonRpcRequest
 * @typedef {import("./acp-protocol").JsonRpcResponse} JsonRpcResponse
 * @typedef {import("./acp-protocol").JsonRpcNotification} JsonRpcNotification
 * @typedef {import("./acp-protocol").AcpNotification} AcpNotification
 * @typedef {import("./acp-protocol").InitializeResult} InitializeResult
 */

/**
 * @callback NotificationHandler
 * @param {JsonRpcNotification} notification
 * @returns {void}
 */

/**
 * Build an `onRequest` handler that auto-approves agent permission requests
 * AND services client-side ACP methods (terminal/*) that the agent expects us
 * to provide.
 *
 * Without this, ACP agents that ask for permission to call tools (web search,
 * MCP, edits, etc.) hang forever waiting for our response. Cursor's `/debug`
 * mode additionally relies on `terminal/*` to run shell commands.
 *
 * Handles:
 *   - `session/request_permission` (Gemini, Cursor)
 *   - `cursor/ask_question` (Cursor's multiple-choice flavor — auto-pick first)
 *   - `terminal/create`, `terminal/output`, `terminal/wait_for_exit`,
 *     `terminal/kill`, `terminal/release` (ACP terminal services)
 *
 * For any other unhandled method we log to stderr and return `{}` instead of
 * throwing `-32601 Method not supported`. Some ACP agents (notably Cursor)
 * silently retry forever when they receive `-32601`, causing session hangs.
 *
 * Each call returns a fresh handler with its own TerminalRegistry, so multiple
 * parallel ACP sessions don't share terminal state.
 *
 * @returns {(method: string, params: any) => any}
 */
export function buildAutoApproveRequestHandler() {
  const terminals = new TerminalRegistry();

  return async (method, params) => {
    if (method === "session/request_permission") {
      const options = Array.isArray(params?.options) ? params.options : [];
      const pick =
        options.find((o) => /allow.?always/i.test(String(o?.optionId ?? ""))) ??
        options.find((o) => /allow.?once/i.test(String(o?.optionId ?? ""))) ??
        options.find((o) => /^(allow|approve|grant)/i.test(String(o?.optionId ?? ""))) ??
        options[0];
      const optionId = pick?.optionId ?? "allow_always";
      return { outcome: { outcome: "selected", optionId } };
    }

    if (method === "cursor/ask_question") {
      const questions = Array.isArray(params?.questions) ? params.questions : [];
      const answers = questions.map((q) => ({
        questionId: q?.id,
        optionId: q?.options?.[0]?.id ?? q?.options?.[0]?.optionId ?? null
      }));
      return { outcome: { outcome: "answered", answers } };
    }

    if (method === "terminal/create") return terminals.create(params);
    if (method === "terminal/output") return terminals.output(params);
    if (method === "terminal/wait_for_exit") return terminals.waitForExit(params);
    if (method === "terminal/kill") return terminals.kill(params);
    if (method === "terminal/release") return terminals.release(params);

    if (process.env.ACP_TRACE) {
      try {
        process.stderr.write(
          `[acp-client] unhandled incoming method: ${method} params=${JSON.stringify(params ?? {}).slice(0, 200)}\n`
        );
      } catch {
        // Best-effort.
      }
    }
    // Return an empty result rather than throwing -32601. Cursor in particular
    // treats method-not-found as a transient error and silently retries the
    // same request forever, which manifests as a session hang with no output.
    return {};
  };
}

// ─── Base Client ──────────────────────────────────────────────────────────────

class AcpClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.transport = "unknown";
    this.nextId = 1;

    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void }>} */
    this.pending = new Map();

    /** @type {NotificationHandler | null} */
    this.onNotification = options.onNotification ?? null;
    this.onDiagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : null;
    /**
     * Handler for INCOMING JSON-RPC requests sent BY the agent (e.g.,
     * `session/request_permission`). Without this, the agent stalls forever
     * waiting for our response. Signature: (method, params) => result | Promise<result>.
     * Throw to send a JSON-RPC error back.
     * @type {((method: string, params: any) => any) | null}
     */
    this.onRequest = typeof options.onRequest === "function" ? options.onRequest : null;

    this.lineBuffer = "";
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.exitResolved = false;
    this.exitError = null;
    this.closed = false;

    /** @type {InitializeResult | null} */
    this.capabilities = null;
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (process.env.ACP_TRACE) {
      try {
        const kind = "id" in message && message.id !== null
          ? (message.method ? "REQ" : "RES")
          : "NOTIF";
        let summary = message.method ?? (message.error ? `error:${message.error?.code}` : "result");
        if (message.method === "session/update") {
          const update = message.params?.update;
          summary = `session/update[${update?.sessionUpdate ?? "?"}]`;
          if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
            summary += ` payload=${JSON.stringify(update).slice(0, 350)}`;
          }
        }
        process.stderr.write(`[acp-trace] <- ${kind} ${summary}\n`);
      } catch {
        // Best-effort.
      }
    }

    // Message with an id. Could be a response to one of OUR requests, or an
    // INCOMING REQUEST from the agent (JSON-RPC requests have both id and
    // method; responses have id without method).
    if ("id" in message && message.id !== null) {
      // Response to one of our outgoing requests.
      if (!message.method) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.error) {
            pending.reject(message.error);
          } else {
            pending.resolve(message.result);
          }
        }
        return;
      }

      // Incoming request from the agent (e.g. session/request_permission).
      // Without a reply the agent stalls — dispatch to onRequest if registered,
      // otherwise return a method-not-found error so the agent fails fast
      // instead of hanging.
      this.handleIncomingRequest(message);
      return;
    }

    // Notification (no id).
    if (message.method === BROKER_DIAGNOSTIC_METHOD) {
      // Trust boundary: only the broker transport may emit
      // broker/diagnostic as a trusted diagnostic. In direct mode the peer is
      // the `gemini --acp` child — a forged notification on its stdout MUST
      // NOT be promoted to a broker diagnostic.
      if (this.transport === "broker") {
        if (this.onDiagnostic) {
          try {
            this.onDiagnostic({
              source: message.params?.source ?? "broker",
              message: message.params?.message ?? ""
            });
          } catch {
            // Best-effort telemetry.
          }
        }
        // Single-dispatch: do NOT also forward to onNotification, otherwise
        // callers that register both handlers would record the diagnostic
        // twice.
        return;
      }
      // Direct mode: fall through to the regular onNotification path so the
      // caller can decide how to handle (or ignore) the untrusted payload.
    }

    if (message.method && this.onNotification) {
      this.onNotification(message);
    }
  }

  /**
   * Dispatch an incoming JSON-RPC request from the peer (agent) and reply.
   *
   * @param {{ id: number | string, method: string, params?: any }} message
   */
  async handleIncomingRequest(message) {
    const respond = (response) => {
      try {
        this.sendMessage({ jsonrpc: "2.0", id: message.id, ...response });
      } catch {
        // If we can't reply, the agent will hang — but there's nothing more we can do.
      }
    };

    if (!this.onRequest) {
      respond({
        error: {
          code: -32601,
          message: `Method not supported: ${message.method}`
        }
      });
      return;
    }

    try {
      const result = await this.onRequest(message.method, message.params);
      respond({ result: result ?? {} });
    } catch (error) {
      const isObj = error && typeof error === "object";
      respond({
        error: {
          code: isObj && typeof error.code === "number" ? error.code : -32603,
          message: isObj && typeof error.message === "string" ? error.message : String(error)
        }
      });
    }
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.lineBuffer.indexOf("\n")) !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
    }
    // Guard against an unbounded line-less flood from a misbehaving peer.
    if (this.lineBuffer.length > ACP_MAX_LINE_BUFFER) {
      const dropped = this.lineBuffer.length - ACP_MAX_LINE_BUFFER;
      this.lineBuffer = this.lineBuffer.slice(-ACP_MAX_LINE_BUFFER);
      if (this.onDiagnostic) {
        try {
          this.onDiagnostic({
            source: "acp-transport",
            message: sanitizeDiagnosticMessage(
              `[line buffer overflow — dropped ${dropped} bytes]`
            )
          });
        } catch {
          // Best-effort telemetry — never let diagnostic delivery crash the ACP client.
        }
      }
    }
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  async request(method, params) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params: params ?? {} };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.sendMessage(message);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  notify(method, params) {
    this.sendMessage({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  /**
   * Initialize the ACP connection with a handshake.
   *
   * @returns {Promise<InitializeResult>}
   */
  async handshake() {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      // Declare `terminal: true` so any agent that uses the standard ACP
      // terminal/* RPCs (and we have handlers for them) can route shell
      // exec through us. Cursor doesn't use those RPCs in agent acp mode —
      // its tool-permission gate runs out-of-band and is handled at spawn
      // time via --yolo/--approve-mcps (see adapters/cursor.mjs).
      clientCapabilities: {
        terminal: true
      },
      clientInfo: {
        name: PLUGIN_MANIFEST.name ?? "gemini-plugin-cc",
        version: PLUGIN_MANIFEST.version ?? "1.0.0"
      }
    });
    this.capabilities = result;
    return result;
  }

  async close() {
    throw new Error("close must be implemented by subclasses.");
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("ACP connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

// ─── Windows-safe CLI binary resolver ─────────────────────────────────────────
//
// On Windows, CLIs installed via npm global install (or Cursor's own installer)
// arrive as `.cmd` wrapper files. Node's spawn() with an array of args will fail
// with EINVAL when the target resolves to a .cmd. The fix is to build a single
// command string and pass `shell: true` so cmd.exe interprets it correctly.
//
// resolveCliBinary converts any binary name (or absolute path) into an absolute
// forward-slash path that is safe to embed in a shell command string.

function resolveCliBinary(command) {
  // If the caller already provided a path (absolute or relative with separators),
  // just normalise backslashes to forward slashes.
  if (command.includes("/") || command.includes("\\")) {
    return command.replace(/\\/g, "/");
  }
  // On non-Windows, trust the shell to resolve via PATH.
  if (process.platform !== "win32") {
    return command;
  }
  // On Windows, use `where` to locate the first match (.cmd / .exe / .bat).
  try {
    const found = execSync(`where "${command}"`, { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)[0];
    return found ? found.replace(/\\/g, "/") : command;
  } catch {
    return command;
  }
}

// ─── Windows env backfill ─────────────────────────────────────────────────────
//
// Some host environments (notably Claude Code subagents on Windows) spawn the
// companion with a stripped env that's missing the Windows variables `agent.cmd`
// + `cursor-agent.ps1` rely on (USERPROFILE, APPDATA, LOCALAPPDATA, USERNAME,
// HOME, SystemRoot, ComSpec). When those are absent the .cmd wrapper launches
// but the inner node process silently fails to start, so the ACP `initialize`
// reply never arrives and the spawned client hangs forever.
//
// buildSpawnEnvironment() returns a new env object with sensible defaults
// backfilled for any missing critical var. Idempotent — vars that are already
// set pass through unchanged.

function buildSpawnEnvironment(baseEnv) {
  if (process.platform !== "win32") {
    return baseEnv ?? process.env;
  }
  const env = { ...(baseEnv ?? process.env) };
  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (home) {
    if (!env.USERPROFILE) env.USERPROFILE = home;
    if (!env.HOME) env.HOME = home;
    if (!env.APPDATA) env.APPDATA = path.join(home, "AppData", "Roaming");
    if (!env.LOCALAPPDATA) env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  }
  if (!env.USERNAME) {
    try {
      env.USERNAME = os.userInfo().username;
    } catch {
      // best-effort
    }
  }
  if (!env.SystemRoot) env.SystemRoot = "C:\\WINDOWS";
  if (!env.ComSpec) env.ComSpec = path.join(env.SystemRoot, "system32", "cmd.exe");
  return env;
}

// ─── Direct (Spawned) Client ──────────────────────────────────────────────────

export class SpawnedAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    // Build a Windows-safe command string. Using shell: true with a single
    // quoted-path command string avoids EINVAL failures when the CLI is a
    // .cmd wrapper (common for npm global installs and Cursor on Windows).
    const command = resolveCliBinary(this.options.command ?? "gemini");
    const args = this.options.args ?? ["--acp"];
    const cmdStr = `"${command}" ${args.join(" ")}`;
    this.proc = spawn(cmdStr, {
      cwd: this.cwd,
      env: buildSpawnEnvironment(this.options.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: true
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.on("exit", (code) => {
      this.handleExit(code !== 0 ? new Error(`${cmdStr} exited with code ${code}`) : null);
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    // Capture bounded stderr lines as diagnostics; always drain to prevent back-pressure.
    if (this.proc.stderr) {
      attachStderrDiagnosticCollector(this.proc.stderr, (message) => {
        if (this.onDiagnostic) {
          try {
            this.onDiagnostic({ source: "direct-stderr", message });
          } catch {
            // Best-effort.
          }
        }
      });
    }

    await this.handshake();
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    const pid = this.proc?.pid;
    if (this.proc?.stdin) {
      try {
        this.proc.stdin.end();
      } catch {
        // stdin may already be closed.
      }
    }

    // Give a brief grace period, then force kill the process tree.
    if (pid) {
      setTimeout(() => {
        try {
          terminateProcessTree(pid);
        } catch {
          // Already exited.
        }
      }, 50).unref?.();
    }

    // Last-resort hard timeout: if the child still hasn't emitted "exit"
    // 3s after the kill attempt, give up waiting and synthesize an exit so
    // callers (notably runAcpPrompt's finally block) don't hang forever.
    // This guards against rare cases where taskkill silently fails or the
    // proc handle never receives the "exit" event.
    const fallbackTimer = setTimeout(() => {
      if (!this.exitResolved) {
        this.handleExit(new Error("ACP child did not exit within 3s of close(); abandoning."));
      }
    }, 3050);
    fallbackTimer.unref?.();

    await this.exitPromise;
    clearTimeout(fallbackTimer);
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("ACP child process stdin is not available.");
    }
    stdin.write(line);
  }
}

// ─── Broker Client ────────────────────────────────────────────────────────────

class BrokerAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(null);
      });
    });

    await this.handshake();
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("ACP broker connection is not connected.");
    }
    socket.write(line);
  }
}

// ─── Test-only helpers ───────────────────────────────────────────────────────
//
// Exposes pieces of AcpClientBase to unit tests without having to spawn a real
// child process or bind a broker socket. Not part of the public API — anything
// prefixed with `__` is test-only.

export const __testing = {
  /**
   * Invoke AcpClientBase.handleLine against a fake client object.
   *
   * @param {{ transport: string, pending: Map<number, any>, nextId: number,
   *           lineBuffer: string, onNotification?: Function,
   *           onDiagnostic?: Function }} client
   * @param {string} line
   */
  handleLineOn(client, line) {
    return AcpClientBase.prototype.handleLine.call(client, line);
  },

  /**
   * Invoke AcpClientBase.handleChunk against a fake client object. Used to
   * exercise the line-buffer overflow diagnostic without spawning a real
   * subprocess or broker socket.
   *
   * @param {{ transport: string, pending: Map<number, any>, nextId: number,
   *           lineBuffer: string, onNotification?: Function,
   *           onDiagnostic?: Function }} client
   * @param {string} chunk
   */
  handleChunkOn(client, chunk) {
    return AcpClientBase.prototype.handleChunk.call(client, chunk);
  }
};

// ─── Factory ──────────────────────────────────────────────────────────────────

export class GeminiAcpClient {
  /**
   * Connect to a Gemini ACP instance. Tries broker first, falls back to direct.
   *
   * @param {string} cwd
   * @param {{ disableBroker?: boolean, brokerEndpoint?: string | null, reuseExistingBroker?: boolean, env?: NodeJS.ProcessEnv, onNotification?: NotificationHandler, onDiagnostic?: (payload: { source: string, message: string }) => void }} [options]
   * @returns {Promise<AcpClientBase>}
   */
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }

    if (brokerEndpoint) {
      try {
        const client = new BrokerAcpClient(cwd, { ...options, brokerEndpoint });
        await client.initialize();
        return client;
      } catch (error) {
        // If broker is busy, fall through to direct spawn.
        const fallbackMessage = error?.code === BROKER_BUSY_RPC_CODE
          ? "Broker busy, falling back to direct gemini --acp spawn."
          : `Broker connection failed (${error?.message ?? error}), falling back to direct spawn.`;
        process.stderr.write(`${fallbackMessage}\n`);
        if (typeof options.onDiagnostic === "function") {
          try {
            options.onDiagnostic({
              source: "broker-fallback",
              message: sanitizeDiagnosticMessage(fallbackMessage)
            });
          } catch {
            // Best-effort.
          }
        }
      }
    }

    // Direct spawn fallback.
    const client = new SpawnedAcpClient(cwd, options);
    await client.initialize();
    return client;
  }
}

/**
 * Qwen Code adapter — availability checks, auth status, and running prompts
 * through Qwen Code CLI's ACP server (`qwen --acp`).
 *
 * Qwen Code is the `qwen` command (or `qwen.cmd` on Windows), installed
 * globally via `npm install -g @qwen-code/qwen-code`. It is a Gemini-CLI
 * fork, optimized for Qwen3-Coder, and speaks the standard JSON-RPC
 * Agent Client Protocol over stdio (using @agentclientprotocol/sdk).
 *
 * The `--acp` flag graduated from `--experimental-acp` in Qwen Code v0.15.6
 * (PR #1355). The deprecated alias is still accepted but emits a warning,
 * so we always pass the stable flag.
 *
 * Qwen Code does not currently expose role-specific slash modes (/plan,
 * /debug, etc.) — it runs as a single agent. Role prefixing is therefore
 * a no-op today, but the structure is preserved for future extension.
 */

import { execSync } from "node:child_process";
import process from "node:process";
import { buildAutoApproveRequestHandler, SpawnedAcpClient } from "../acp-client.mjs";
import { sanitizeDiagnosticMessage } from "../acp-diagnostics.mjs";
import { buildStandardMcpServers } from "../mcp-servers.mjs";

// ─── Binary resolution ────────────────────────────────────────────────────────
//
// Qwen Code is installed globally via npm and lives in the npm global bin
// directory. On Windows this is %APPDATA%\npm\qwen.cmd; on Unix it's
// `qwen` on PATH.

const QWEN_WINDOWS_FALLBACK =
  (process.env.APPDATA ?? "C:/Users/" + (process.env.USERNAME ?? process.env.USER ?? "WalshLab") + "/AppData/Roaming") +
  "/npm/qwen.cmd";

function findQwenBinary() {
  // User override always wins.
  if (process.env.QWEN_CODE_CLI_PATH) {
    return process.env.QWEN_CODE_CLI_PATH.replace(/\\/g, "/");
  }

  // Try `where` (Windows) / `which` (Unix) to find the binary on PATH.
  const whereCmd = process.platform === "win32" ? "where qwen" : "which qwen";
  try {
    const found = execSync(whereCmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
      .split(/\r?\n/)
      .filter(Boolean)[0];
    if (found) {
      return found.replace(/\\/g, "/");
    }
  } catch {
    // Not on PATH — fall through to platform-specific fallback.
  }

  if (process.platform === "win32") {
    return QWEN_WINDOWS_FALLBACK;
  }

  // Non-Windows: return plain name and trust PATH.
  return "qwen";
}

// ─── Role-to-prompt-prefix mapping ───────────────────────────────────────────
//
// Qwen Code currently has no role-specific slash modes — it runs as a single
// agent. Returning the user task unchanged is correct today; if Qwen later
// adds /plan or /debug modes (it forks Gemini CLI, which doesn't have them
// either), this map is the place to wire them.

/**
 * Prepend the Qwen slash-command prefix for the given role.
 *
 * @param {string} role  — "writer" or other
 * @param {string} userTask
 * @returns {string}
 */
function buildPrompt(role, userTask) {
  const prefix = {
    // No role-specific prefixes today.
  }[role] ?? "";
  return prefix + userTask;
}

// ─── Stream event helpers ─────────────────────────────────────────────────────

function emitStreamEvent(onStream, event) {
  if (!onStream) return;
  try {
    onStream(event);
  } catch {
    // Best-effort.
  }
}

// ─── Notification dispatch ────────────────────────────────────────────────────

function createNotificationSinks() {
  return {
    textChunks: [],
    chunkCount: 0,
    chunkChars: 0,
    toolCalls: [],
    fileChanges: [],
    events: []
  };
}

function dispatchOneNotification(notification, sinks, onStream) {
  const update = notification?.params?.update;
  if (!update) return;

  if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
    const text = String(update.content.text ?? "");
    sinks.textChunks.push(text);
    sinks.chunkCount += 1;
    sinks.chunkChars += text.length;
    const ev = { type: "message_chunk", text };
    sinks.events?.push(ev);
    emitStreamEvent(onStream, ev);
  } else if (update.sessionUpdate === "tool_call") {
    sinks.toolCalls.push({
      name: update.toolName ?? update.name ?? "unknown",
      arguments: update.arguments ?? update.input ?? {},
      result: update.result ?? undefined
    });
    const ev = {
      type: "tool_call",
      toolName: sanitizeDiagnosticMessage(update.toolName ?? update.name ?? "unknown") || "unknown"
    };
    sinks.events?.push(ev);
    emitStreamEvent(onStream, ev);
  } else if (update.sessionUpdate === "file_change") {
    sinks.fileChanges.push({
      path: update.path ?? "",
      action: update.action ?? "modify"
    });
    const ev = {
      type: "file_change",
      path: sanitizeDiagnosticMessage(update.path ?? ""),
      action: sanitizeDiagnosticMessage(update.action ?? "modify") || "modify"
    };
    sinks.events?.push(ev);
    emitStreamEvent(onStream, ev);
  }
}

// ─── Availability & Auth ──────────────────────────────────────────────────────

/**
 * Check whether the Qwen Code CLI binary is available.
 *
 * @returns {{ available: boolean, detail: string, version: string | null }}
 */
export function getQwenAvailability() {
  const cli = findQwenBinary();
  try {
    const version = execSync(`"${cli}" --version`, {
      encoding: "utf8",
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 8000
    }).trim();
    return { available: true, detail: `qwen ${version}`, version };
  } catch (err) {
    return {
      available: false,
      detail: `Qwen Code CLI not found (tried: ${cli}). Install with: npm install -g @qwen-code/qwen-code@latest. Error: ${String(err.message ?? err)}`,
      version: null
    };
  }
}

/**
 * Check Qwen authentication status.
 *
 * Qwen supports multiple auth backends (Qwen OAuth, OpenAI-compatible APIs,
 * DashScope, ModelScope, OpenRouter) configured via `~/.qwen/settings.json`
 * or environment variables. We do a lightweight probe: if the binary works,
 * we treat the user as authenticated and let the ACP layer surface real auth
 * failures on the first prompt. Standard provider env vars short-circuit
 * the binary probe.
 *
 * @returns {{ authenticated: boolean, loggedIn: boolean, method: string | null, detail: string }}
 */
export function getQwenAuthStatus() {
  const tokenEnvVars = ["OPENAI_API_KEY", "QWEN_API_KEY", "DASHSCOPE_API_KEY"];
  for (const envVar of tokenEnvVars) {
    if (process.env[envVar]) {
      return {
        authenticated: true,
        loggedIn: true,
        method: envVar,
        detail: `Authenticated via ${envVar} environment variable.`
      };
    }
  }

  // Fall back to checking binary availability — if qwen --version works,
  // the binary is installed and (probably) has cached OAuth credentials.
  // Real auth failures will surface naturally on the first ACP prompt.
  const avail = getQwenAvailability();
  if (avail.available) {
    return {
      authenticated: true,
      loggedIn: true,
      method: "qwen-cli",
      detail: `Qwen Code CLI available (${avail.version}). Auth will be confirmed on first use.`
    };
  }

  return {
    authenticated: false,
    loggedIn: false,
    method: null,
    detail: "Qwen Code CLI not found. Install with `npm install -g @qwen-code/qwen-code@latest`, then run `qwen` to log in (Qwen OAuth is free), or set OPENAI_API_KEY for an OpenAI-compatible provider."
  };
}

// ─── ACP Operations ───────────────────────────────────────────────────────────

/**
 * Run a prompt through Qwen Code ACP and capture the result.
 *
 * @param {string} cwd
 * @param {string} prompt  — should already have role prefix applied via buildPrompt()
 * @param {{ model?: string, role?: string, sessionId?: string, env?: NodeJS.ProcessEnv, onNotification?: (n: any) => void, onStream?: (event: any) => void }} [options]
 * @returns {Promise<{ sessionId: string | null, text: string, chunkCount: number, chunkChars: number, toolCalls: Array<any>, fileChanges: Array<any>, error: unknown }>}
 */
export async function runAcpPromptQwen(cwd, prompt, options = {}) {
  const sinks = createNotificationSinks();
  const role = options.role ?? "writer";
  const fullPrompt = buildPrompt(role, prompt);

  const notificationHandler = (notification) => {
    dispatchOneNotification(notification, sinks, options.onStream);
    if (options.onNotification) {
      options.onNotification(notification);
    }
  };

  const diagnosticHandler = (payload) => {
    if (options.onDiagnostic) {
      try {
        options.onDiagnostic(payload);
      } catch {
        // Best-effort.
      }
    }
  };

  const cli = findQwenBinary();
  const client = new SpawnedAcpClient(cwd, {
    command: cli,
    args: ["--acp"],
    env: options.env ?? process.env,
    onNotification: notificationHandler,
    onDiagnostic: diagnosticHandler,
    onRequest: buildAutoApproveRequestHandler()
  });

  const mcpServers = buildStandardMcpServers();

  try {
    await client.initialize();

    let sessionId = options.sessionId ?? null;
    if (sessionId) {
      await client.request("session/load", { sessionId, cwd, mcpServers });
    } else {
      const session = await client.request("session/new", { cwd, mcpServers });
      sessionId = session?.sessionId ?? null;
    }

    if (options.model) {
      try {
        await client.request("session/set_model", { sessionId, modelId: options.model });
      } catch (error) {
        process.stderr.write(`Warning: could not set model to ${options.model}: ${error?.message ?? error}\n`);
      }
    }

    const result = await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: fullPrompt }]
    });

    const text = sinks.textChunks.join("");

    return {
      sessionId,
      text,
      chunkCount: sinks.chunkCount,
      chunkChars: sinks.chunkChars,
      toolCalls: sinks.toolCalls,
      fileChanges: sinks.fileChanges,
      error: null
    };
  } catch (error) {
    return {
      sessionId: null,
      text: sinks.textChunks.join(""),
      chunkCount: sinks.chunkCount,
      chunkChars: sinks.chunkChars,
      toolCalls: sinks.toolCalls,
      fileChanges: sinks.fileChanges,
      error
    };
  } finally {
    await client.close();
  }
}

/**
 * Interrupt an active Qwen ACP session (best-effort; Qwen may not implement cancel).
 *
 * @param {string} jobId
 * @returns {Promise<{ attempted: boolean, interrupted: boolean, transport: string | null, detail: string }>}
 */
export async function interruptAcpPromptQwen(jobId) {
  // Qwen ACP does not currently expose a cancel endpoint; return a no-op result.
  return {
    attempted: false,
    interrupted: false,
    transport: null,
    detail: `Cancel not implemented for Qwen ACP (jobId: ${jobId}).`
  };
}

// ─── Generic adapter interface ────────────────────────────────────────────────

export const adapter = {
  name: "qwen",
  isAvailable: getQwenAvailability,
  isAuthenticated: getQwenAuthStatus,
  invoke: runAcpPromptQwen,
  cancel: interruptAcpPromptQwen,
  getSession: undefined
};

/**
 * Cursor adapter — availability checks, auth status, and running prompts
 * through Cursor's headless print mode (`agent -p`).
 *
 * Cursor's CLI is the `agent` command, installed by Cursor into a per-user
 * location (e.g. C:/Users/<name>/AppData/Local/cursor-agent/agent.cmd on
 * Windows). We drive it in non-interactive print mode and parse its structured
 * output:
 *   - --output-format json        → a single {type:"result", ...} object
 *   - --output-format stream-json  → newline-delimited events + a final result
 *
 * The prompt is delivered on STDIN (not as a CLI arg) so multi-line prompts and
 * shell metacharacters never need cmd.exe quoting.
 *
 * Roles map to flags (not to /slash prefixes as the old ACP path did):
 *   delegate / writer / debugger → default agent mode + --force --trust  (writes)
 *   research / researcher        → --mode ask --force                    (read-only + web)
 *   explore / explorer / ask     → --mode ask --force                    (read-only)
 *
 * Headless replaces the previous `agent acp` (ACP JSON-RPC) transport, which on
 * this CLI carried two upstream bugs: MCP tool-calls silently stopped firing
 * (~2026.04.17) and there was no working cancel. Headless `-p` fires MCP/web
 * tools normally and is cancelled by killing the process tree.
 */

import { execSync } from "node:child_process";
import readline from "node:readline";
import process from "node:process";

import { spawnCommand } from "../process.mjs";
import { buildSpawnEnvironment } from "../acp-client.mjs";
import { sanitizeDiagnosticMessage } from "../acp-diagnostics.mjs";

// ─── Binary resolution ────────────────────────────────────────────────────────
//
// Cursor ships its agent CLI as a .cmd wrapper on Windows. We try:
//   1. CURSOR_AGENT_PATH env var (user override)
//   2. `where agent` / `which agent` via the shell
//   3. Well-known Windows fallback path

const CURSOR_AGENT_WINDOWS_FALLBACK =
  "C:/Users/" +
  (process.env.USERNAME ?? process.env.USER ?? "WalshLab") +
  "/AppData/Local/cursor-agent/agent.cmd";

function findCursorBinary() {
  // User override always wins.
  if (process.env.CURSOR_AGENT_PATH) {
    return process.env.CURSOR_AGENT_PATH.replace(/\\/g, "/");
  }

  // Try `where` (Windows) / `which` (Unix) to find the binary on PATH.
  const whereCmd = process.platform === "win32" ? "where agent" : "which agent";
  try {
    const found = execSync(whereCmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
      .split(/\r?\n/)
      .filter(Boolean)[0];
    if (found) {
      return found.replace(/\\/g, "/");
    }
  } catch {
    // Not on PATH — fall through to hardcoded Windows path.
  }

  if (process.platform === "win32") {
    return CURSOR_AGENT_WINDOWS_FALLBACK;
  }

  // Non-Windows: return plain name and trust PATH.
  return "agent";
}

// ─── Model IDs (informational) ────────────────────────────────────────────────
// Model names are passed straight through via --model; the adapter does not
// validate them (Cursor itself rejects an unknown id with exit 1 + a stderr
// "Available models: ..." list, which we surface). The current catalog is
// available live via `agent models` / `agent --list-models` — do not hardcode it
// here; it drifts. `auto` is the intended default. Flat names like
// `gpt-5.5-medium`, `claude-opus-4-8-thinking-high`, `composer-2.5-fast` work
// (the bracketed `modelId[...]` form the old ACP path resolved is NOT used).

// ─── Role → headless flags ────────────────────────────────────────────────────

const READ_ONLY_ROLES = new Set([
  "research",
  "researcher",
  "explore",
  "explorer",
  "ask",
  "planner",
  "plan"
]);

/** Read-only roles run in `--mode ask` and never write files. */
export function isReadOnlyRole(role) {
  return READ_ONLY_ROLES.has(String(role ?? "").toLowerCase());
}

/**
 * Read-only roles only need the final answer (json); write roles use stream-json
 * so we can surface live progress and derive file/command activity per turn.
 */
export function headlessOutputFormat(role) {
  return isReadOnlyRole(role) ? "json" : "stream-json";
}

/**
 * Build the `agent` argv (prompt is delivered on stdin, never here).
 *
 * @param {{ role?: string, model?: string, sessionId?: string|null, cwd?: string, outputFormat?: string }} [opts]
 * @returns {string[]}
 */
export function buildHeadlessArgs({ role = "delegate", model, sessionId, cwd, outputFormat } = {}) {
  const fmt = outputFormat ?? headlessOutputFormat(role);
  const args = ["-p", "--output-format", fmt];
  if (fmt === "stream-json") {
    args.push("--stream-partial-output");
  }
  const resolvedModel = model && String(model).trim() ? String(model).trim() : "auto";
  args.push("--model", resolvedModel);
  if (isReadOnlyRole(role)) {
    // Read-only Q&A/planning. --force keeps the built-in WebFetch tool from
    // stalling on the approval gate; --mode ask refuses edits even under --force.
    args.push("--mode", "ask", "--force");
  } else {
    // Default agent mode: full tools incl. write + shell. --force auto-approves
    // tool execution; --trust (headless-only) trusts the workspace without a prompt.
    args.push("--force", "--trust");
  }
  if (cwd) {
    args.push("--workspace", cwd);
  }
  if (sessionId) {
    // Resume a prior session — context is preserved server-side.
    args.push("--resume", String(sessionId));
  }
  return args;
}

// ─── Known-bad version warning ────────────────────────────────────────────────
//
// The headless `-p` path fires MCP/web tools fine (the 2026.04.17 ACP MCP
// regression was headless-fixed in a late-May update). The one bug it does NOT
// fix is the Windows shell-tool hang: Cursor's bash resolver / WSL2 sandbox can
// make a shell command hang on this OS (host-PATH ordering, still open upstream).
// We do not run shell verification through Cursor (the caller verifies), so this
// does not affect delegate's file writes. Warn once if a known-affected build is
// detected.
//   https://forum.cursor.com/t/shell-commands-in-agent-mode-are-not-returning-output/155544
//   https://forum.cursor.com/t/agent-command-execution-uses-wsl-instead-of-the-windows-default-integrated-terminal-git-bash/160196

const KNOWN_BROKEN_CURSOR_VERSIONS = new Set([
  "2026.04.17-787b533",
  "2026.04.29-c83a488"
]);
let warnedAboutCursorVersion = false;
// The version probe shells out (`agent --version`); run it at most once per
// process so an --until-done loop doesn't pay a blocking execSync per turn.
let cursorVersionProbed = false;

function maybeWarnAboutCursorVersion(versionString) {
  if (warnedAboutCursorVersion) return;
  if (!versionString) return;
  const v = String(versionString).trim();
  if (!KNOWN_BROKEN_CURSOR_VERSIONS.has(v)) return;
  warnedAboutCursorVersion = true;
  process.stderr.write(
    `[cursor] Note: agent ${v} predates the headless MCP-regression fix (~late May 2026). ` +
    `Update Cursor (\`agent update\`) if MCP tools don't fire. Separately, Cursor's shell tool ` +
    `can hang on Windows (host-PATH/WSL); this plugin defers verification to the caller, so it ` +
    `does not affect file writes.\n`
  );
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

/** Extract the tool kind from a stream-json tool_call object (keyed e.g. `shellToolCall`). */
export function streamToolKind(toolCallObj) {
  if (!toolCallObj || typeof toolCallObj !== "object") return "tool";
  const key = Object.keys(toolCallObj)[0] ?? "tool";
  return key.replace(/ToolCall$/, "") || "tool";
}

function extractAssistantText(event) {
  const content = event?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

/**
 * Map a stream-json event to a progress event for the companion's onStream sink.
 * task.mjs forwards only `phase` events to the user, so tool-call starts become
 * phase pings ("things happening"); assistant deltas become message_chunks
 * (filtered as token noise downstream but available for richer sinks).
 *
 * @returns {{ type: string, [k: string]: any } | null}
 */
export function mapStreamEventToProgress(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "tool_call" && event.subtype === "started") {
    const kind = streamToolKind(event.tool_call);
    return { type: "phase", message: `Cursor: ${sanitizeDiagnosticMessage(kind) || "tool"}`, phase: kind };
  }
  if (event.type === "assistant") {
    const text = extractAssistantText(event);
    if (text) return { type: "message_chunk", text };
  }
  return null;
}

// ─── Output parsing (pure) ─────────────────────────────────────────────────────

// A completed tool-call counts as a file change when its key carries an edit
// verb AND it targets a path. This is POSITIVE matching — not a read-pattern veto
// — so edit tools whose names contain "search" (e.g. `search_replace`) are not
// misclassified as reads. The path requirement filters non-file tools that happen
// to match a verb (e.g. `create_chat`, which has no path). Read/search/grep/glob
// tool keys carry no edit verb, so they never match.
const EDIT_TOOL_PATTERN = /(write|edit|create|delete|move|rename|patch|replace)/i;

/** Derive file changes from completed edit tool_call events that target a path. */
export function deriveFileChanges(events) {
  const out = [];
  const seen = new Set();
  for (const e of events ?? []) {
    if (e?.type !== "tool_call" || e.subtype !== "completed") continue;
    const tc = e.tool_call;
    if (!tc || typeof tc !== "object") continue;
    const key = Object.keys(tc)[0] ?? "";
    if (!EDIT_TOOL_PATTERN.test(key)) continue;
    const inner = tc[key] ?? {};
    const path = inner.args?.path ?? inner.result?.success?.path ?? null;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const action = /delete/i.test(key) ? "delete" : /create/i.test(key) ? "create" : "modify";
    out.push({ path, action });
  }
  return out;
}

/** Derive shell command executions from completed shell tool_call events. */
export function deriveCommandExecutions(events) {
  const out = [];
  for (const e of events ?? []) {
    if (e?.type !== "tool_call" || e.subtype !== "completed") continue;
    const tc = e.tool_call;
    const key = tc && typeof tc === "object" ? Object.keys(tc)[0] : null;
    if (key !== "shellToolCall") continue;
    const command = tc.shellToolCall?.args?.command ?? "";
    out.push({ command });
  }
  return out;
}

/** Lightweight tool-call list (name only) from completed tool_call events. */
export function deriveToolCalls(events) {
  const out = [];
  for (const e of events ?? []) {
    if (e?.type !== "tool_call" || e.subtype !== "completed") continue;
    out.push({ name: streamToolKind(e.tool_call) });
  }
  return out;
}

function firstSessionId(events) {
  for (const e of events ?? []) {
    if (e && typeof e === "object" && e.session_id) return e.session_id;
  }
  return null;
}

/** Parse the single result object emitted by `--output-format json`. */
export function parseJsonResult(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === "object") return obj;
  } catch {
    // Fall through to a line scan for the result object.
  }
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try {
      const obj = JSON.parse(l);
      if (obj?.type === "result") return obj;
    } catch {
      // keep scanning
    }
  }
  return null;
}

/**
 * Normalize a finished headless run into the adapter result shape. Pure: takes
 * the collected output and returns what invoke() resolves with.
 *
 * IMPORTANT: startup/validation errors (bad model, auth) print plain text to
 * stderr with a non-zero exit code and produce NO json envelope — so we branch
 * on exit code AND on the parsed result, never on the result alone.
 *
 * @returns {{ sessionId: string|null, text: string, error: object|null, status: number, fileChanges: Array, commandExecutions: Array, toolCalls: Array }}
 */
export function normalizeHeadlessOutcome({ events = [], stdoutText = "", stderr = "", exitCode = 0, outputFormat = "json" } = {}) {
  const resultObj = outputFormat === "stream-json"
    ? (events.filter((e) => e?.type === "result").pop() ?? null)
    : parseJsonResult(stdoutText);

  const fileChanges = deriveFileChanges(events);
  const commandExecutions = deriveCommandExecutions(events);
  const toolCalls = deriveToolCalls(events);

  if (!resultObj) {
    const message = (stderr || "").trim()
      || (stdoutText || "").trim()
      || `Cursor produced no result (exit ${exitCode}).`;
    return { sessionId: firstSessionId(events), text: "", error: { message }, status: exitCode || 1, fileChanges, commandExecutions, toolCalls };
  }

  const text = typeof resultObj.result === "string" ? resultObj.result : "";
  const sessionId = resultObj.session_id ?? firstSessionId(events) ?? null;
  const isError = Boolean(resultObj.is_error) || exitCode !== 0;
  const error = isError
    ? { message: text || (stderr || "").trim() || "Cursor reported an error." }
    : null;
  const status = isError ? (exitCode || 1) : 0;

  return { sessionId, text, error, status, fileChanges, commandExecutions, toolCalls };
}

// ─── Availability & Auth ──────────────────────────────────────────────────────

/**
 * Check whether the Cursor agent CLI binary is available.
 *
 * @returns {{ available: boolean, detail: string, version: string | null }}
 */
export function getCursorAvailability() {
  const cli = findCursorBinary();
  try {
    const version = execSync(`"${cli}" --version`, {
      encoding: "utf8",
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 8000
    }).trim();
    return { available: true, detail: `agent ${version}`, version };
  } catch (err) {
    return {
      available: false,
      detail: `Cursor agent CLI not found (tried: ${cli}). Error: ${String(err.message ?? err)}`,
      version: null
    };
  }
}

/**
 * Check Cursor authentication status via `agent status`.
 *
 * @returns {{ authenticated: boolean, loggedIn: boolean, method: string | null, detail: string }}
 */
export function getCursorAuthStatus() {
  const cli = findCursorBinary();
  try {
    const output = execSync(`"${cli}" status`, {
      encoding: "utf8",
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000
    });
    const lower = output.toLowerCase();
    // Look for common "not signed in" / "not logged in" indicators.
    const notSignedIn =
      lower.includes("not signed in") ||
      lower.includes("not logged in") ||
      lower.includes("unauthenticated") ||
      lower.includes("please sign in");
    if (notSignedIn) {
      return { authenticated: false, loggedIn: false, method: null, detail: output.trim() };
    }
    return { authenticated: true, loggedIn: true, method: "cursor-account", detail: output.trim() };
  } catch (err) {
    return {
      authenticated: false,
      loggedIn: false,
      method: null,
      detail: String(err.message ?? err)
    };
  }
}

// ─── Headless turn ─────────────────────────────────────────────────────────────

/**
 * Run a single prompt through Cursor headless print mode and capture the result.
 * The prompt is written to stdin (newline-safe). For write roles we stream-parse
 * NDJSON and surface progress via onStream; for read-only roles we collect the
 * single json result. The execution mode (agent vs ask) is derived from
 * `options.role` via isReadOnlyRole; `options.write` is accepted for caller
 * symmetry but is not read here.
 *
 * @param {string} cwd
 * @param {string} prompt
 * @param {{ model?: string, role?: string, write?: boolean, sessionId?: string|null, env?: NodeJS.ProcessEnv, onStream?: (event: any) => void, outputFormat?: string }} [options]
 * @returns {Promise<{ sessionId: string|null, text: string, error: object|null, status: number, fileChanges: Array, commandExecutions: Array, toolCalls: Array }>}
 */
export async function runHeadlessCursorTurn(cwd, prompt, options = {}) {
  const role = options.role ?? "delegate";
  const outputFormat = options.outputFormat ?? headlessOutputFormat(role);
  const args = buildHeadlessArgs({
    role,
    model: options.model,
    sessionId: options.sessionId,
    cwd,
    outputFormat
  });
  const cli = findCursorBinary();
  if (!cursorVersionProbed) {
    cursorVersionProbed = true;
    maybeWarnAboutCursorVersion(getCursorAvailability().version);
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawnCommand(cli, args, {
        cwd,
        env: buildSpawnEnvironment(options.env ?? process.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      finish({ sessionId: null, text: "", error, status: 1, fileChanges: [], commandExecutions: [], toolCalls: [] });
      return;
    }

    const events = [];
    let stdoutText = "";
    let stderrText = "";

    if (outputFormat === "stream-json") {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          return;
        }
        events.push(evt);
        const progress = mapStreamEventToProgress(evt);
        if (progress) emitStreamEvent(options.onStream, progress);
      });
    } else if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdoutText += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrText += chunk.toString();
      });
    }

    child.on("error", (error) => {
      finish({ sessionId: null, text: "", error, status: 1, fileChanges: [], commandExecutions: [], toolCalls: [] });
    });

    child.on("close", (code) => {
      finish(normalizeHeadlessOutcome({ events, stdoutText, stderr: stderrText, exitCode: code ?? 0, outputFormat }));
    });

    // Deliver the prompt on stdin (newline-safe; avoids cmd.exe arg quoting).
    try {
      if (child.stdin) {
        child.stdin.write(prompt ?? "");
        child.stdin.end();
      }
    } catch {
      // stdin may already be closed if the child errored on spawn.
    }
  });
}

/**
 * Cancel a Cursor headless job. The authoritative cancellation is the
 * companion's process-tree kill of the job's pid (handleCancel); this reports
 * the mechanism so the contract member is honored.
 *
 * @param {string} jobId
 */
export async function cancelHeadlessCursor(jobId) {
  return {
    attempted: true,
    interrupted: false,
    transport: "process-tree",
    detail: `Cursor headless jobs are cancelled by killing the process tree (job ${jobId}).`
  };
}

// ─── Generic adapter interface ────────────────────────────────────────────────

export const adapter = {
  name: "cursor",
  isAvailable: getCursorAvailability,
  isAuthenticated: getCursorAuthStatus,
  invoke: runHeadlessCursorTurn,
  cancel: cancelHeadlessCursor,
  getSession: undefined
};

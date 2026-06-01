/**
 * Antigravity adapter — drives Google's `agy` CLI (Antigravity CLI) in headless
 * print mode and reads the answer back from the on-disk conversation transcript.
 *
 * WHY THE TRANSCRIPT, NOT STDOUT (verified live on agy v1.0.3, Windows 11):
 *   `agy -p "<prompt>"` runs a full model turn, but when stdout is NOT a TTY
 *   (i.e. a pipe / subprocess, exactly our case) it writes ZERO bytes to
 *   stdout — an upstream bug (gemini-cli#27466, `text_drip.go` isatty gate),
 *   still open in 1.0.3. The model's answer IS reliably persisted to disk as
 *   structured JSONL at:
 *     ~/.gemini/antigravity-cli/brain/<conv-id>/.system_generated/logs/transcript.jsonl
 *   So we spawn `agy -p`, ignore its (empty) stdout, learn the conversation id
 *   from a per-invocation `--log-file` (`Created conversation <id>`), and parse
 *   the transcript: the last non-empty MODEL/PLANNER_RESPONSE step is the answer;
 *   typed MODEL steps (SEARCH_WEB, VIEW_FILE, LIST_DIRECTORY, ...) are the trail.
 *
 * SCOPE: read-only `research` / `explore` only (no `--dangerously-skip-permissions`
 *   → the default request-review gate means write tools never auto-run headless).
 *   Write-`delegate`, per-call `--model` (no headless flag — model is the configured
 *   default, Gemini 3.5 Flash), and `--until-done` are intentionally NOT supported.
 *
 * EXPERIMENTAL: this depends on `agy`'s undocumented transcript layout + log lines.
 *   Re-verify if `agy` changes. Authenticating/automating via Google's own official
 *   `agy` binary (and reading only our own local files) is ToS-safe — unlike the
 *   abandoned desktop-Language-Server reverse-engineering approach.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { spawnCommand, terminateProcessTree } from "../process.mjs";
import { buildSpawnEnvironment } from "../acp-client.mjs";

// ─── Binary resolution ──────────────────────────────────────────────────────
//
// `agy` is a single Go binary. On Windows the installer drops it at
// %LOCALAPPDATA%\agy\bin\agy.exe (a real .exe → process.mjs spawns it WITHOUT a
// shell, so the prompt passes safely as an argv element — no cmd.exe quoting).

function localAppDataRoot() {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA.replace(/\\/g, "/");
  const user = process.env.USERNAME ?? process.env.USER ?? "user";
  return `C:/Users/${user}/AppData/Local`;
}

const AGY_WINDOWS_FALLBACK = `${localAppDataRoot()}/agy/bin/agy.exe`;

export function findAgyBinary() {
  // User override always wins.
  if (process.env.AGY_CLI_PATH) {
    return process.env.AGY_CLI_PATH.replace(/\\/g, "/");
  }
  const whereCmd = process.platform === "win32" ? "where agy" : "which agy";
  try {
    const found = execSync(whereCmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
      .split(/\r?\n/)
      .filter(Boolean)[0];
    if (found) return found.replace(/\\/g, "/");
  } catch {
    // Not on PATH — fall through.
  }
  if (process.platform === "win32") return AGY_WINDOWS_FALLBACK;
  return "agy";
}

// ─── Role → flags ─────────────────────────────────────────────────────────────

const READ_ONLY_ROLES = new Set([
  "research",
  "researcher",
  "explore",
  "explorer",
  "ask",
  "planner",
  "plan"
]);

/** The Antigravity slice ships read-only roles only; this gates write flags. */
export function isReadOnlyRole(role) {
  return READ_ONLY_ROLES.has(String(role ?? "").toLowerCase());
}

/**
 * Build the `agy` argv. The prompt is passed inline as the `-p` value (safe as a
 * single argv element since agy.exe spawns without a shell). Read-only roles omit
 * `--dangerously-skip-permissions` so write tools stay gated behind request-review.
 *
 * @param {{ prompt?: string, cwd?: string, logFile?: string, printTimeout?: string, role?: string }} [opts]
 * @returns {string[]}
 */
export function buildHeadlessArgs({ prompt, cwd, logFile, printTimeout, role = "researcher" } = {}) {
  const args = ["-p", String(prompt ?? "")];
  if (cwd) args.push("--add-dir", cwd);
  if (logFile) args.push("--log-file", logFile);
  if (printTimeout) args.push("--print-timeout", String(printTimeout));
  if (!isReadOnlyRole(role)) {
    // Write role (not shipped yet): auto-approve tool execution.
    args.push("--dangerously-skip-permissions");
  }
  return args;
}

// ─── Pure parsing of the log + transcript ──────────────────────────────────────

/** Extract the conversation id `agy` created this run, from its log output. */
export function parseConversationId(logText) {
  const text = String(logText ?? "");
  const created = text.match(/Created conversation ([0-9a-fA-F-]+)/);
  if (created) return created[1];
  const inline = text.match(/conversation=([0-9a-fA-F-]+)/);
  return inline ? inline[1] : null;
}

/** Extract the CLI app-data dir from the log (where brain/<id>/... lives). */
export function parseAppDataDir(logText) {
  const m = String(logText ?? "").match(/CLI app data directory:\s*(.+)/);
  return m ? m[1].trim() : null;
}

/** Default app-data dir when the log does not surface it. */
export function defaultAppDataDir() {
  return path.join(os.homedir(), ".gemini", "antigravity-cli");
}

/** Absolute path to a conversation's transcript JSONL. */
export function transcriptPath(appDataDir, convId) {
  return path.join(appDataDir, "brain", convId, ".system_generated", "logs", "transcript.jsonl");
}

/** Parse transcript JSONL into step objects (robust: skips unparseable lines). */
export function parseTranscript(jsonlText) {
  const out = [];
  for (const line of String(jsonlText ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object") out.push(obj);
    } catch {
      // skip
    }
  }
  return out;
}

const RESPONSE_TYPE = "PLANNER_RESPONSE";

/** The final answer = the last non-empty MODEL/PLANNER_RESPONSE content. */
export function deriveFinalMessage(steps) {
  let answer = "";
  for (const s of steps ?? []) {
    if (s?.source === "MODEL" && s?.type === RESPONSE_TYPE && typeof s.content === "string" && s.content.trim()) {
      answer = s.content;
    }
  }
  return answer.trim();
}

/** Every MODEL action step that isn't the planner's prose is a tool call. */
export function deriveToolCalls(steps) {
  const out = [];
  for (const s of steps ?? []) {
    if (s?.source === "MODEL" && s?.type && s.type !== RESPONSE_TYPE) {
      out.push({ name: s.type });
    }
  }
  return out;
}

// File-mutating / command step types (for the future write role; read-only runs
// never produce these, so derivation returns [] in practice today).
const EDIT_STEP_TYPES = new Set([
  "EDIT_FILE", "WRITE_FILE", "CREATE_FILE", "REPLACE_FILE",
  "APPLY_PATCH", "DELETE_FILE", "MOVE_FILE", "RENAME_FILE"
]);
const COMMAND_STEP_TYPES = new Set([
  "RUN_COMMAND", "EXECUTE_COMMAND", "RUN_TERMINAL_COMMAND", "TERMINAL", "SHELL"
]);

function fileUriFromContent(content) {
  const m = String(content ?? "").match(/file:\/\/\/([^\s`"]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Derive file changes from edit-typed MODEL steps that target a path. */
export function deriveFileChanges(steps) {
  const out = [];
  const seen = new Set();
  for (const s of steps ?? []) {
    if (s?.source !== "MODEL" || !EDIT_STEP_TYPES.has(s?.type)) continue;
    const filePath = fileUriFromContent(s.content);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    const action = /DELETE/.test(s.type) ? "delete" : /CREATE/.test(s.type) ? "create" : "modify";
    out.push({ path: filePath, action });
  }
  return out;
}

/** Derive shell command executions from command-typed MODEL steps. */
export function deriveCommandExecutions(steps) {
  const out = [];
  for (const s of steps ?? []) {
    if (s?.source !== "MODEL" || !COMMAND_STEP_TYPES.has(s?.type)) continue;
    const m = String(s.content ?? "").match(/Command:\s*(.+)/);
    out.push({ command: m ? m[1].trim() : String(s.content ?? "").trim() });
  }
  return out;
}

/**
 * Normalize a finished `agy` run into the uniform adapter result shape. Pure: the
 * conversation id comes from the log, the answer + activity from the transcript.
 *
 * @param {{ logText?: string, transcriptText?: string, stderr?: string, exitCode?: number, timedOut?: boolean }} [args]
 * @returns {{ sessionId: string|null, text: string, error: object|null, status: number, fileChanges: Array, commandExecutions: Array, toolCalls: Array }}
 */
export function normalizeAgyOutcome({ logText = "", transcriptText = "", stderr = "", exitCode = 0, timedOut = false } = {}) {
  const sessionId = parseConversationId(logText);
  const steps = parseTranscript(transcriptText);
  const text = deriveFinalMessage(steps);
  const fileChanges = deriveFileChanges(steps);
  const commandExecutions = deriveCommandExecutions(steps);
  const toolCalls = deriveToolCalls(steps);

  if (timedOut) {
    return {
      sessionId,
      text,
      error: { message: "Antigravity (agy) timed out before producing a response." },
      status: 1,
      fileChanges,
      commandExecutions,
      toolCalls
    };
  }

  if (!text) {
    const detail = (stderr || "").trim();
    const message = detail
      ? `Antigravity (agy) produced no answer. ${detail}`
      : "Antigravity (agy) produced no answer (empty or unreadable transcript). Ensure `agy` is installed and signed in (run `agy` once interactively).";
    return { sessionId, text: "", error: { message }, status: exitCode || 1, fileChanges, commandExecutions, toolCalls };
  }

  return { sessionId, text, error: null, status: 0, fileChanges, commandExecutions, toolCalls };
}

// ─── Availability & Auth ────────────────────────────────────────────────────

/**
 * Whether the `agy` CLI binary is present.
 * @returns {{ available: boolean, detail: string, version: string | null }}
 */
export function getAntigravityAvailability() {
  const cli = findAgyBinary();
  try {
    const version = execSync(`"${cli}" --version`, {
      encoding: "utf8",
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 8000
    }).trim();
    return { available: true, detail: `agy ${version}`, version };
  } catch (err) {
    return {
      available: false,
      detail: `Antigravity CLI (agy) not found (tried: ${cli}). Install it from https://antigravity.google and run \`agy\` once to sign in. Error: ${String(err.message ?? err)}`,
      version: null
    };
  }
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Best-effort auth check. `agy` signs in via OAuth (consumer tier) and stores
 * creds under ~/.gemini; their presence is a reliable proxy for "signed in".
 * @returns {{ authenticated: boolean, loggedIn: boolean, method: string | null, detail: string }}
 */
export function getAntigravityAuthStatus() {
  const home = os.homedir();
  const signedIn =
    fileExists(path.join(home, ".gemini", "oauth_creds.json")) &&
    fileExists(path.join(home, ".gemini", "google_accounts.json"));
  if (signedIn) {
    return {
      authenticated: true,
      loggedIn: true,
      method: "oauth-keyring",
      detail: "Antigravity (agy) appears signed in (OAuth creds present in ~/.gemini)."
    };
  }
  return {
    authenticated: false,
    loggedIn: false,
    method: null,
    detail: "Antigravity (agy) is not signed in. Run `agy` once interactively and sign in with your Google account."
  };
}

// ─── Headless turn ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * Read the transcript with a short retry — by process close it is normally fully
 * written, but a brief lag (and the Windows `.tmp→.pb` rename race) can leave it
 * a beat behind. Returns as soon as a final answer is present.
 */
async function readTranscriptWithRetry(appDataDir, convId, attempts = 6, delayMs = 120) {
  const p = transcriptPath(appDataDir, convId);
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const text = readTextSafe(p);
    if (text) {
      last = text;
      if (deriveFinalMessage(parseTranscript(text))) return text;
    }
    await sleep(delayMs);
  }
  return last;
}

let logCounter = 0;

/**
 * Run a single prompt through `agy -p` and recover the answer from the transcript.
 *
 * @param {string} cwd
 * @param {string} prompt
 * @param {{ role?: string, model?: string, write?: boolean, env?: NodeJS.ProcessEnv, onStream?: (event: any) => void, timeoutMs?: number, printTimeout?: string }} [options]
 * @returns {Promise<{ sessionId: string|null, text: string, error: object|null, status: number, fileChanges: Array, commandExecutions: Array, toolCalls: Array }>}
 */
export async function runHeadlessAgyTurn(cwd, prompt, options = {}) {
  const role = options.role ?? "researcher";
  const cli = findAgyBinary();
  const watchdogMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 300000;
  const printTimeout = options.printTimeout ?? `${Math.max(30, Math.round(watchdogMs / 1000) - 10)}s`;
  const logFile = path.join(os.tmpdir(), `agy-${process.pid}-${Date.now()}-${logCounter++}.log`);
  const args = buildHeadlessArgs({ prompt, cwd, logFile, printTimeout, role });

  // No live token stream is possible (stdout is empty by design), so emit a single
  // phase ping for the progress sink that task.mjs forwards to the user.
  if (options.onStream) {
    try {
      options.onStream({ type: "phase", message: "Antigravity: running agy -p (Gemini 3.5 Flash)", phase: "agy" });
    } catch {
      // best-effort
    }
  }

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
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
        // stdin closed (avoids inherited-stdin hangs); stdout ignored (empty by
        // the upstream bug); stderr captured for startup/validation errors.
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      finish({ sessionId: null, text: "", error, status: 1, fileChanges: [], commandExecutions: [], toolCalls: [] });
      return;
    }

    let stderrText = "";
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrText += chunk.toString();
      });
    }

    const watchdog = setTimeout(() => {
      timedOut = true;
      if (Number.isFinite(child.pid)) {
        try {
          terminateProcessTree(child.pid);
        } catch {
          // best-effort
        }
      }
    }, watchdogMs);

    child.on("error", (error) => {
      clearTimeout(watchdog);
      finish({ sessionId: null, text: "", error, status: 1, fileChanges: [], commandExecutions: [], toolCalls: [] });
    });

    child.on("close", async (code) => {
      clearTimeout(watchdog);
      const logText = readTextSafe(logFile);
      const convId = parseConversationId(logText);
      const appDataDir = parseAppDataDir(logText) || defaultAppDataDir();
      const transcriptText = convId ? await readTranscriptWithRetry(appDataDir, convId) : "";
      try {
        fs.rmSync(logFile, { force: true });
      } catch {
        // best-effort cleanup
      }
      finish(normalizeAgyOutcome({ logText, transcriptText, stderr: stderrText, exitCode: code ?? 0, timedOut }));
    });
  });
}

/**
 * Cancel an Antigravity headless job. The authoritative cancel is the companion's
 * process-tree kill of the job's pid (handleCancel); this reports the mechanism.
 * @param {string} jobId
 */
export async function cancelHeadlessAgy(jobId) {
  return {
    attempted: true,
    interrupted: false,
    transport: "process-tree",
    detail: `Antigravity (agy) jobs are cancelled by killing the process tree (job ${jobId}).`
  };
}

// ─── Generic adapter interface ────────────────────────────────────────────────

export const adapter = {
  name: "antigravity",
  isAvailable: getAntigravityAvailability,
  isAuthenticated: getAntigravityAuthStatus,
  invoke: runHeadlessAgyTurn,
  cancel: cancelHeadlessAgy,
  getSession: undefined
};

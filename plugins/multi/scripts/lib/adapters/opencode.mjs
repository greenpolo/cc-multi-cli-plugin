/**
 * OpenCode adapter — availability checks, auth status, and running prompts
 * through OpenCode's headless run mode (`opencode run --format json`).
 *
 * OpenCode (SST `opencode`, npm `opencode-ai`) is driven non-interactively. We
 * spawn `opencode run --format json` over a PIPED stdout (stdio:["pipe",...])
 * and parse the newline-delimited JSON (NDJSON) it streams. The earlier "non-TTY
 * hang" scare is a powershell `Start-Process -RedirectStandardOutput`/`> file`
 * artifact; a pipe (what node child_process gives us) works — exit 0, valid
 * NDJSON in a few seconds. This is the cursor transport with a different binary
 * and event schema.
 *
 * NDJSON event types (one JSON object per line, `sessionID` on every line):
 *   - step_start                         → a turn step began
 *   - text         (part.text)           → assistant text delta
 *   - step_finish  (part.reason==="stop") → end of turn
 *   - tool_use     (part.tool, part.state.status, part.state.input) → a tool ran
 *   - reasoning                          → model reasoning (ignored for output)
 *   - error        (error.data.message)  → a run/validation error
 *
 * The prompt is delivered on STDIN (not as a CLI arg) so multi-line prompts and
 * shell metacharacters never need cmd.exe quoting. On win32 the npm binary
 * resolves to `opencode.cmd`, which process.mjs routes through cmd.exe;
 * quoteWindowsShellArg THROWS on any newline-containing arg — so the prompt MUST
 * go on stdin, exactly like cursor.mjs.
 *
 * Roles map to flags + a spawn-env permission floor (OpenCode has NO --read-only
 * flag, and `--agent <subagent>` silently falls back to the full-write `build`
 * agent):
 *   delegate / writer / debugger → run --format json --model <m> --dangerously-skip-permissions   (writes)
 *   research / researcher        → run --format json --model <m> --agent oc-research              (read-only + web)
 *   explore / explorer / ask/... → run --format json --model <m> --agent oc-explore              (read-only repo)
 * For read-only roles we ALSO inject OPENCODE_CONFIG_CONTENT (defining the oc-*
 * primary agent with edit/bash/write denied) AND an OPENCODE_PERMISSION deny
 * floor, so even a silent agent-name fallback cannot write. normalizeHeadlessOutcome
 * additionally fails the turn if stderr shows "Falling back to default agent".
 *
 * TOKEN-OFFLOAD WARNING: `anthropic/*` models (via the opencode-claude-auth
 * plugin) reuse your Claude Code subscription → ZERO offload. Real offload comes
 * from `opencode/*` (Zen), `openai/*`, `google/*`, `github-copilot/*`, `ollama/*`.
 * The default below is `opencode/claude-opus-4-8` (Zen, billed separately).
 *
 * TWO-BINARY NOTE: a stale bun `opencode.exe` (older, same SST project) can shadow
 * the npm `opencode.cmd`. findOpencodeBinary never resolves to `opencode.exe`.
 */

import { execSync } from "node:child_process";
import readline from "node:readline";
import process from "node:process";

import { spawnCommand } from "../process.mjs";
import { buildSpawnEnvironment } from "../acp-client.mjs";
import { sanitizeDiagnosticMessage } from "../acp-diagnostics.mjs";
import { runAcpTurn } from "../acp/client.mjs";
import { resolveOpenCodeAcp } from "../acp/resolve.mjs";

// ─── Binary resolution ────────────────────────────────────────────────────────
//
// 1. OPENCODE_CLI_PATH env var (operator override) → normalize \ → /.
// 2. Otherwise return the BARE name "opencode" and let spawnCommand /
//    process.mjs `resolveWindowsCommand` pick the `.cmd` and normalize slashes.
//    We do NOT take the first `where opencode` line — on win32 that is the
//    EXTENSIONLESS npm shim (…\npm\opencode), which node spawn cannot execute
//    (ENOENT). And we never resolve to `opencode.exe` (the stale bun build).

export function findOpencodeBinary() {
  // User override always wins.
  if (process.env.OPENCODE_CLI_PATH) {
    return process.env.OPENCODE_CLI_PATH.replace(/\\/g, "/");
  }
  // Bare name; process.mjs resolveWindowsCommand selects the .cmd on win32 and
  // normalizes slashes, and trusts PATH elsewhere. This avoids the extensionless
  // npm shim (ENOENT) and never auto-promotes the stale bun opencode.exe.
  return "opencode";
}

// ─── Model IDs (informational) ──────────────────────────────────────────────
// `--model` is a HARD invariant: with no top-level `model` key in config, a run
// without --model uses the LAST-USED model — which may be anthropic/* (= zero
// offload, silently). So we ALWAYS pass --model, resolving:
//   options.model || OPENCODE_CLI_DEFAULT_MODEL || "opencode/claude-opus-4-8"
// The id form is `provider/model`. Catalog drifts (155+ models) — re-verify the
// default against `opencode models opencode` rather than hardcoding more here.

const DEFAULT_OPENCODE_MODEL = "opencode/claude-opus-4-8";

export function resolveModel(model) {
  if (model && String(model).trim()) return String(model).trim();
  const envDefault = process.env.OPENCODE_CLI_DEFAULT_MODEL;
  if (envDefault && String(envDefault).trim()) return String(envDefault).trim();
  return DEFAULT_OPENCODE_MODEL;
}

// ─── Role → flags / agent ─────────────────────────────────────────────────────

const READ_ONLY_ROLES = new Set([
  "research",
  "researcher",
  "explore",
  "explorer",
  "ask",
  "planner",
  "plan"
]);

/** Read-only roles run under an injected oc-* primary agent and never write files. */
export function isReadOnlyRole(role) {
  return READ_ONLY_ROLES.has(String(role ?? "").toLowerCase());
}

/** Roles that want web access (research family) vs codebase-only (explore family). */
function isResearchRole(role) {
  const r = String(role ?? "").toLowerCase();
  return r === "research" || r === "researcher";
}

/**
 * OpenCode has only `--format default | json`; json is NDJSON and serves both
 * read-only and write roles (there is no stream-json distinction like cursor's),
 * so the format is "json" for every role.
 */
export function headlessOutputFormat(_role) {
  return "json";
}

/** The injected oc-* primary agent name for a read-only role. */
export function readOnlyAgentName(role) {
  return isResearchRole(role) ? "oc-research" : "oc-explore";
}

/**
 * Build the `opencode` argv (prompt is delivered on stdin, NEVER here — the
 * win32 .cmd shim throws on newline args).
 *
 * @param {{ role?: string, model?: string, sessionId?: string|null, cwd?: string }} [opts]
 * @returns {string[]}
 */
export function buildHeadlessArgs({ role = "delegate", model, sessionId, cwd } = {}) {
  const args = ["run", "--format", headlessOutputFormat(role), "--model", resolveModel(model)];
  if (cwd && String(cwd).trim()) {
    // Pin OpenCode's working directory (cursor's --workspace analog). NOTE: when
    // cwd is INSIDE a git repo, OpenCode resolves writes to the repo ROOT (its
    // project model) regardless of --dir; --dir is honored verbatim for non-git
    // targets. Live-verified on 1.15.13.
    args.push("--dir", String(cwd));
  }
  if (sessionId) {
    // Resume an exact prior session — NEVER --continue (cross-dir pollution).
    args.push("--session", String(sessionId));
  }
  if (isReadOnlyRole(role)) {
    // Read-only: route to the injected oc-* primary agent (defined via
    // OPENCODE_CONFIG_CONTENT in the spawn env). NO --dangerously-skip-permissions.
    args.push("--agent", readOnlyAgentName(role));
  } else {
    // Write/delegate: auto-approve tool execution (auto-replies "once" to each ask).
    args.push("--dangerously-skip-permissions");
  }
  return args;
}

// ─── Read-only spawn-env floor ──────────────────────────────────────────────
//
// OpenCode has no --read-only flag, and `--agent explore`/`scout`/`general`
// silently fall back to the full-write `build` agent. So for read-only roles we
// inject a custom PRIMARY agent (oc-research / oc-explore) via
// OPENCODE_CONFIG_CONTENT with edit/bash/write denied, AND an OPENCODE_PERMISSION
// deny-floor — so even a fallback-to-build cannot write. We also clear the
// (UNVERIFIED-but-cheap) OPENCODE_SERVER_PASSWORD/USERNAME for ALL roles.

const READ_ONLY_BASE_PERMISSION = {
  edit: "deny",
  bash: "deny",
  write: "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  external_directory: "allow"
};

/** The OPENCODE_CONFIG_CONTENT JSON defining the oc-* primary agent for a role. */
export function buildReadOnlyConfigContent(role) {
  const agentName = readOnlyAgentName(role);
  const permission = isResearchRole(role)
    ? { ...READ_ONLY_BASE_PERMISSION, webfetch: "allow", websearch: "allow" }
    : { ...READ_ONLY_BASE_PERMISSION, webfetch: "deny", websearch: "deny" };
  return JSON.stringify({
    agent: {
      [agentName]: {
        mode: "primary",
        permission
      }
    }
  });
}

/** The OPENCODE_PERMISSION deny-floor JSON injected for read-only roles. */
export const READ_ONLY_PERMISSION_FLOOR = JSON.stringify({
  edit: "deny",
  bash: "deny",
  write: "deny"
});

/**
 * Compose the spawn env for a turn: always clear OPENCODE_SERVER_PASSWORD/USERNAME;
 * for read-only roles inject the oc-* primary agent config + the deny floor.
 * Pure (returns a new object; never mutates the input).
 *
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {string} role
 * @returns {NodeJS.ProcessEnv}
 */
export function buildOpencodeSpawnEnv(baseEnv, role) {
  const env = buildSpawnEnvironment({ ...(baseEnv ?? process.env) });
  // Defensive: a stale server credential can trigger an upstream "Session not
  // found" bug if inherited. Clear for every role — zero cost.
  delete env.OPENCODE_SERVER_PASSWORD;
  delete env.OPENCODE_SERVER_USERNAME;
  if (isReadOnlyRole(role)) {
    env.OPENCODE_CONFIG_CONTENT = buildReadOnlyConfigContent(role);
    env.OPENCODE_PERMISSION = READ_ONLY_PERMISSION_FLOOR;
  }
  return env;
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

/** Extract the tool kind from a tool_use event (`part.tool`, e.g. bash|read|write|edit). */
export function streamToolKind(event) {
  const tool = event?.part?.tool;
  return typeof tool === "string" && tool ? tool : "tool";
}

/**
 * Map an NDJSON event to a progress event for the companion's onStream sink.
 * task.mjs forwards only `phase` events to the user, so tool_use / step_start
 * become phase pings; text becomes a message_chunk (richer sinks only).
 *
 * @returns {{ type: string, [k: string]: any } | null}
 */
export function mapEventToProgress(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "tool_use") {
    const kind = streamToolKind(event);
    return { type: "phase", message: `OpenCode: ${sanitizeDiagnosticMessage(kind) || "tool"}`, phase: kind };
  }
  if (event.type === "step_start") {
    return { type: "phase", message: "OpenCode: step", phase: "step" };
  }
  if (event.type === "text") {
    const text = typeof event.part?.text === "string" ? event.part.text : "";
    if (text) return { type: "message_chunk", text };
  }
  return null;
}

// ─── Output parsing (pure) ─────────────────────────────────────────────────────

// A completed tool_use counts as a file change when its `part.tool` carries an
// edit verb AND it targets a path (part.state.input.filePath). POSITIVE matching
// (not a read-pattern veto), so edit tools whose names contain "search" (e.g.
// search_replace) are NOT misclassified as reads. Read/glob/grep/list tools
// carry no edit verb, so they never match.
const EDIT_TOOL_PATTERN = /(write|edit|create|delete|move|rename|patch|replace)/i;

function isCompletedToolUse(e) {
  return e?.type === "tool_use" && e?.part?.state?.status === "completed";
}

/** Derive file changes from completed edit tool_use events that target a path. */
export function deriveFileChanges(events) {
  const out = [];
  const seen = new Set();
  for (const e of events ?? []) {
    if (!isCompletedToolUse(e)) continue;
    const tool = e.part.tool ?? "";
    if (!EDIT_TOOL_PATTERN.test(tool)) continue;
    const path = e.part?.state?.input?.filePath ?? null;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const action = /delete/i.test(tool) ? "delete" : /create/i.test(tool) ? "create" : "modify";
    out.push({ path, action });
  }
  return out;
}

/** Derive shell command executions from completed bash tool_use events. */
export function deriveCommandExecutions(events) {
  const out = [];
  for (const e of events ?? []) {
    if (!isCompletedToolUse(e)) continue;
    if (e.part.tool !== "bash") continue;
    const command = e.part?.state?.input?.command ?? "";
    out.push({ command });
  }
  return out;
}

/** Lightweight tool-call list (name only) from completed tool_use events. */
export function deriveToolCalls(events) {
  const out = [];
  for (const e of events ?? []) {
    if (!isCompletedToolUse(e)) continue;
    out.push({ name: streamToolKind(e) });
  }
  return out;
}

/** First event carrying a sessionID (present on every line in practice). */
export function firstSessionId(events) {
  for (const e of events ?? []) {
    if (e && typeof e === "object" && e.sessionID) return e.sessionID;
  }
  return null;
}

/** Concatenate all `text` part deltas into the assistant answer. */
function concatText(events) {
  let text = "";
  for (const e of events ?? []) {
    if (e?.type === "text" && typeof e.part?.text === "string") {
      text += e.part.text;
    }
  }
  return text;
}

/** Whether a step_finish with part.reason==="stop" (end-of-turn) was seen. */
function sawStop(events) {
  for (const e of events ?? []) {
    if (e?.type === "step_finish" && e?.part?.reason === "stop") return true;
  }
  return false;
}

/** The first {type:"error"} event, if any. */
function firstErrorEvent(events) {
  for (const e of events ?? []) {
    if (e?.type === "error") return e;
  }
  return null;
}

// Read-only agent-resolution failure: an unresolved --agent name prints this to
// stderr and silently degrades to the full-write `build` agent. We FAIL the turn
// when we see it for a read-only role rather than letting a write slip through.
const AGENT_FALLBACK_PATTERN = /Falling back to default agent/i;

/**
 * Normalize a finished headless run into the uniform adapter result shape. Pure:
 * takes the collected events + stderr + exit code and returns what invoke()
 * resolves with.
 *
 * IMPORTANT (two distinct verified failure shapes):
 *   - a bad --model emits a {type:"error"} event AND exits 1;
 *   - a bad --session emits ZERO stdout events, the message on STDERR ONLY, exit 1.
 * So the error branch MUST fire on exitCode!==0 even when `events` is empty —
 * never branch on events alone. Tolerate stderr-only "Missing API key"
 * small_model title-gen noise when a text/step_finish:stop turn was produced.
 *
 * @param {{ events?: Array, stderr?: string, exitCode?: number, role?: string }} [args]
 * @returns {{ sessionId: string|null, text: string, error: object|null, status: number, fileChanges: Array, commandExecutions: Array, toolCalls: Array }}
 */
export function normalizeHeadlessOutcome({ events = [], stderr = "", exitCode = 0, role = "delegate" } = {}) {
  const text = concatText(events);
  const sessionId = firstSessionId(events);
  const fileChanges = deriveFileChanges(events);
  const commandExecutions = deriveCommandExecutions(events);
  const toolCalls = deriveToolCalls(events);
  const stderrTrimmed = (stderr || "").trim();

  // Read-only safety: an unresolved --agent name silently becomes full-write
  // `build`. Fail hard if the fallback line is present.
  if (isReadOnlyRole(role) && AGENT_FALLBACK_PATTERN.test(stderrTrimmed)) {
    return {
      sessionId,
      text: "",
      error: {
        message:
          "OpenCode could not resolve the read-only agent and fell back to the default (full-write) agent. " +
          "Aborting to avoid an unintended write. " +
          (stderrTrimmed || "")
      },
      status: exitCode || 1,
      fileChanges,
      commandExecutions,
      toolCalls
    };
  }

  // Explicit error event (e.g. bad --model) → status 1.
  const errEvent = firstErrorEvent(events);
  if (errEvent) {
    const message =
      errEvent?.error?.data?.message ??
      errEvent?.error?.message ??
      (stderrTrimmed || "OpenCode reported an error.");
    return {
      sessionId,
      text,
      error: { message },
      status: exitCode || 1,
      fileChanges,
      commandExecutions,
      toolCalls
    };
  }

  // Non-zero exit with no error event (e.g. bad --session: zero events, stderr
  // only). Branch on exit code, not on events.
  if (exitCode !== 0) {
    const message = stderrTrimmed || text || `OpenCode produced no result (exit ${exitCode}).`;
    return {
      sessionId,
      text,
      error: { message },
      status: exitCode,
      fileChanges,
      commandExecutions,
      toolCalls
    };
  }

  // Success requires a produced turn: a text answer or an end-of-turn stop.
  if (!text && !sawStop(events)) {
    const message = stderrTrimmed || "OpenCode produced no result.";
    return {
      sessionId,
      text: "",
      error: { message },
      status: 1,
      fileChanges,
      commandExecutions,
      toolCalls
    };
  }

  // Success. stderr-only small_model "Missing API key" noise is ignored here
  // because a text/step_finish:stop turn was produced and exitCode === 0.
  return {
    sessionId,
    text,
    error: null,
    status: 0,
    fileChanges,
    commandExecutions,
    toolCalls
  };
}

// ─── Availability & Auth ──────────────────────────────────────────────────────

/**
 * Check whether the OpenCode CLI binary is available.
 *
 * @returns {{ available: boolean, detail: string, version: string | null }}
 */
export function getOpencodeAvailability() {
  const cli = findOpencodeBinary();
  try {
    const version = execSync(`"${cli}" --version`, {
      encoding: "utf8",
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 8000
    }).trim();
    return { available: true, detail: `opencode ${version}`, version };
  } catch (err) {
    return {
      available: false,
      detail:
        `OpenCode CLI not found (tried: ${cli}). Install it via \`npm install -g opencode-ai\`. ` +
        `Error: ${String(err.message ?? err)}`,
      version: null
    };
  }
}

/**
 * Check OpenCode authentication via `opencode auth list` (subprocess parse, not a
 * bare file check — catches env-var-only creds). Authenticated iff exit 0 and the
 * output contains a `●` provider bullet.
 *
 * @returns {{ authenticated: boolean, loggedIn: boolean, method: string | null, detail: string }}
 */
export function getOpencodeAuthStatus() {
  const cli = findOpencodeBinary();
  try {
    const output = execSync(`"${cli}" auth list`, {
      encoding: "utf8",
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000
    });
    const authenticated = output.includes("●");
    if (authenticated) {
      return { authenticated: true, loggedIn: true, method: "opencode-auth", detail: output.trim() };
    }
    return {
      authenticated: false,
      loggedIn: false,
      method: null,
      detail: output.trim() || "OpenCode reports no authenticated providers. Run `opencode auth login`."
    };
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
 * Run a single prompt through OpenCode headless run mode and capture the result.
 * The prompt is written to stdin (newline-safe). We parse NDJSON off stdout via
 * readline, surface progress through onStream, and derive file/command activity.
 * The execution mode (write vs read-only oc-* agent) is derived from
 * `options.role` via isReadOnlyRole; `options.write` is accepted for caller
 * symmetry but not read here.
 *
 * @param {string} cwd
 * @param {string} prompt
 * @param {{ model?: string, role?: string, write?: boolean, sessionId?: string|null, env?: NodeJS.ProcessEnv, onStream?: (event: any) => void }} [options]
 * @returns {Promise<{ sessionId: string|null, text: string, error: object|null, status: number, fileChanges: Array, commandExecutions: Array, toolCalls: Array }>}
 */
export async function runHeadlessOpencodeTurn(cwd, prompt, options = {}) {
  const role = options.role ?? "delegate";
  const args = buildHeadlessArgs({
    role,
    model: options.model,
    sessionId: options.sessionId,
    cwd
  });
  const cli = findOpencodeBinary();

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
        env: buildOpencodeSpawnEnv(options.env ?? process.env, role),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      finish({ sessionId: null, text: "", error, status: 1, fileChanges: [], commandExecutions: [], toolCalls: [] });
      return;
    }

    const events = [];
    let stderrText = "";

    if (child.stdout) {
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
        const progress = mapEventToProgress(evt);
        if (progress) emitStreamEvent(options.onStream, progress);
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
      finish(normalizeHeadlessOutcome({ events, stderr: stderrText, exitCode: code ?? 0, role }));
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
 * Cancel an OpenCode headless job. The authoritative cancellation is the
 * companion's process-tree kill of the job's pid (handleCancel); this reports the
 * mechanism so the contract member is honored.
 *
 * @param {string} jobId
 */
export async function cancelHeadlessOpencode(jobId) {
  return {
    attempted: true,
    interrupted: false,
    transport: "process-tree",
    detail: `OpenCode headless jobs are cancelled by killing the process tree (job ${jobId}).`
  };
}

// ─── ACP transport (opencode acp) ──────────────────────────────────────────────
//
// Selected per-turn by MULTI_TRANSPORT_OPENCODE=acp (default "headless"). Read at
// invoke() time, not import time, so tests can flip it per case. The contract,
// registry, companion, commands, and skills need ZERO changes: this path returns
// the SAME result shape headless invoke() returns (text/error/sessionId/status/
// fileChanges/commandExecutions/toolCalls) and maps role → read-only env / model
// → set_config_option exactly as the headless path derives them.

/** The transport flag value for OpenCode, read at call time. Default "headless". */
export function opencodeTransport(env = process.env) {
  return String(env.MULTI_TRANSPORT_OPENCODE ?? "").trim().toLowerCase() === "acp"
    ? "acp"
    : "headless";
}

// In-flight ACP turn handles, keyed by jobId, so an in-process cancel() can route
// to the live turn's in-protocol cancel. The authoritative cross-process cancel
// remains handleCancel's process-tree kill (the ACP child is inside the worker's
// tree); this map only adds in-protocol grace when cancel runs in the same process.
const inflightAcpTurns = new Map();

/**
 * Map an ACP session/update to the SAME progress events the headless onStream
 * sink already consumes (phase / message_chunk), so task.mjs's streamForwarder is
 * unchanged. agent_message_chunk → message_chunk; tool_call updates → phase.
 *
 * @returns {{ type: string, [k: string]: any } | null}
 */
export function mapAcpUpdateToProgress(update) {
  if (!update || typeof update !== "object") return null;
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const block = update.content;
    const text = block?.type === "text" && typeof block.text === "string" ? block.text : "";
    if (text) return { type: "message_chunk", text };
    return null;
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const raw = update.title ?? update.kind ?? update.toolCallId ?? "tool";
    return { type: "phase", message: `OpenCode: ${sanitizeDiagnosticMessage(raw) || "tool"}`, phase: kind };
  }
  return null;
}

/**
 * Run a single prompt through OpenCode's ACP transport (`opencode acp`). Maps the
 * adapter's invoke() options onto runAcpTurn and returns the headless result shape.
 *
 * Read-only roles reuse the EXACT same OPENCODE_PERMISSION deny floor + oc-* agent
 * config the headless path builds (buildOpencodeSpawnEnv), so the deny preset is
 * not duplicated. The model is passed straight through (opencode "provider/model"
 * IDs — the same values headless passes to --model); runAcpTurn validates it
 * against the live configOptions and fails before prompting on a miss.
 *
 * @param {string} cwd
 * @param {string} prompt
 * @param {{ model?: string, role?: string, sessionId?: string|null, env?: NodeJS.ProcessEnv, onStream?: (event: any) => void, jobId?: string|null }} [options]
 * @returns {Promise<{ sessionId: string|null, text: string, error: object|null, status: number, fileChanges: Array, commandExecutions: Array, toolCalls: Array }>}
 */
export async function runAcpOpencodeTurn(cwd, prompt, options = {}) {
  const role = options.role ?? "delegate";
  // Tests inject a {exe, args} for the fake ACP agent here (same role resolve.mjs
  // env overrides serve in production); production never passes spawnSpec.
  const resolved = options.spawnSpec ?? resolveOpenCodeAcp({ env: options.env ?? process.env });
  if (!resolved.exe) {
    return {
      sessionId: null,
      text: "",
      error: { message: resolved.detail || "OpenCode ACP executable not found." },
      status: 1,
      fileChanges: [],
      commandExecutions: [],
      toolCalls: []
    };
  }

  // Reuse the headless spawn-env builder verbatim: read-only roles get the oc-*
  // agent config + the OPENCODE_PERMISSION deny floor; write roles do not.
  const env = buildOpencodeSpawnEnv(options.env ?? process.env, role);
  const readOnly = isReadOnlyRole(role);

  const onStream = options.onStream;
  const turn = runAcpTurn({
    exe: resolved.exe,
    args: resolved.args,
    cwd,
    env,
    prompt: prompt ?? "",
    model: resolveModel(options.model),
    allowWrites: !readOnly,
    onUpdate: onStream
      ? (update) => {
          const progress = mapAcpUpdateToProgress(update);
          if (progress) {
            try {
              onStream(progress);
            } catch {
              // Best-effort.
            }
          }
        }
      : undefined,
    onDiagnostic: () => {}
  });

  const jobId = options.jobId ?? null;
  if (jobId) inflightAcpTurns.set(jobId, turn);
  let res;
  try {
    res = await turn;
  } finally {
    if (jobId) inflightAcpTurns.delete(jobId);
  }

  const text = typeof res.text === "string" ? res.text : "";
  const error = res.error ? { message: res.error.message + (res.error.detail ? ` ${res.error.detail}` : "") } : null;
  const status = error ? 1 : 0;
  return {
    sessionId: res.sessionId ?? null,
    text,
    error,
    status,
    // The ACP turn runner does not derive file/command activity (no tool_use
    // schema parse like the NDJSON path). The render layer tolerates empty arrays.
    fileChanges: [],
    commandExecutions: [],
    toolCalls: []
  };
}

/**
 * Cancel an in-flight OpenCode ACP turn. Routes to the live turn's in-protocol
 * cancel handle when the job is running in THIS process; otherwise reports the
 * process-tree mechanism (the authoritative cross-process cancel is
 * handleCancel's process-tree kill — the ACP child sits inside the worker's
 * tree).
 *
 * @param {string} jobId
 */
export async function cancelAcpOpencode(jobId) {
  const turn = jobId ? inflightAcpTurns.get(jobId) : null;
  if (turn && typeof turn.cancel === "function") {
    try {
      turn.cancel();
    } catch {
      // Best-effort; the process-tree kill is the backstop.
    }
    return {
      attempted: true,
      interrupted: true,
      transport: "acp",
      detail: `OpenCode ACP turn cancelled in-protocol (job ${jobId}); process tree killed as backstop.`
    };
  }
  // No in-flight turn in THIS process (the cross-process cancel case): the
  // mechanism that actually does the work is the companion's process-tree kill,
  // so report that honestly — the ACP child sits inside the worker's tree.
  return {
    attempted: true,
    interrupted: false,
    transport: "process-tree",
    detail: `No in-flight ACP turn in this process; OpenCode ACP jobs are cancelled by killing the process tree (job ${jobId}).`
  };
}

// ─── Generic adapter interface ────────────────────────────────────────────────

/**
 * Transport-dispatching invoke: ACP when MULTI_TRANSPORT_OPENCODE=acp, else the
 * unchanged headless path. The default (no flag) is byte-identical to today.
 */
export async function invokeOpencode(cwd, prompt, options = {}) {
  if (opencodeTransport(options.env ?? process.env) === "acp") {
    return runAcpOpencodeTurn(cwd, prompt, options);
  }
  return runHeadlessOpencodeTurn(cwd, prompt, options);
}

/** Transport-dispatching cancel: ACP routing when the flag selects acp. */
export async function cancelOpencode(jobId) {
  if (opencodeTransport(process.env) === "acp") {
    return cancelAcpOpencode(jobId);
  }
  return cancelHeadlessOpencode(jobId);
}

export const adapter = {
  name: "opencode",
  isAvailable: getOpencodeAvailability,
  isAuthenticated: getOpencodeAuthStatus,
  invoke: invokeOpencode,
  cancel: cancelOpencode,
  getSession: undefined
};

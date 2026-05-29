import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { normalizeReasoningEffort, normalizeRequestedModel } from "../task-options.mjs";
import { firstMeaningfulLine, shorten } from "../text.mjs";
import * as cursor from "../adapters/cursor.mjs";
import * as antigravity from "../adapters/antigravity.mjs";
import { getAdapter } from "../adapters/registry.mjs";
import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  runAppServerTurn
} from "../adapters/codex.mjs";
import { readStdinIfPiped } from "../fs.mjs";
import { renderTaskResult } from "../render.mjs";
import { readStoredJob } from "../job-control.mjs";
import {
  listJobs,
  upsertJob,
  writeJobFile
} from "../state.mjs";
import {
  appendLogLine,
  runTrackedJob,
  SESSION_ID_ENV
} from "../tracked-jobs.mjs";
import {
  createCompanionJob,
  createTrackedProgress,
  ensureCodexAvailable,
  formatAdapterError,
  outputCommandResult,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
  resolveLatestTrackedTaskThread,
  ROOT_DIR,
  runForegroundCommand
} from "./shared.mjs";
import { resolveWorkspaceRoot } from "../workspace.mjs";

const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

// ─── Autonomous mode (--until-done) ───────────────────────────────────────────
// When --until-done is set on a Codex task, the companion loops thread/resume
// turns until the model emits PLAN_COMPLETE_SENTINEL on its own line, hits an
// error, runs out of turns, or makes no progress on a follow-up turn.
const PLAN_COMPLETE_SENTINEL = "PLAN COMPLETE";
const PLAN_COMPLETE_PATTERN = /^\s*PLAN\s+COMPLETE\s*$/im;
const DEFAULT_MAX_TURNS = 30;

const AUTONOMOUS_PROTOCOL_HEADER = [
  "AUTONOMOUS MODE: This task runs across multiple Codex turns on the same thread.",
  `When (and only when) the entire plan is complete and verified, emit a line containing exactly: ${PLAN_COMPLETE_SENTINEL}`,
  "Until then, end turns naturally — you will be dispatched again to continue from where you stopped.",
  "Do not summarize prior turns; the thread already has them.",
  ""
].join("\n");

const AUTONOMOUS_CONTINUATION_PROMPT = [
  "Continue executing the plan from the previous turn on this thread.",
  `If — and only if — the entire plan is complete and verified, emit a line containing exactly: ${PLAN_COMPLETE_SENTINEL}`,
  "Otherwise, pick the next plan item and execute it. Do not summarize prior work; do not ask for confirmation."
].join("\n");

export function buildAutonomousInitialPrompt(prompt) {
  const trimmed = String(prompt ?? "").trim();
  return trimmed ? `${AUTONOMOUS_PROTOCOL_HEADER}${trimmed}` : AUTONOMOUS_PROTOCOL_HEADER.trimEnd();
}

export function normalizeMaxTurns(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--max-turns must be a positive integer, got "${value}".`);
  }
  return Math.floor(n);
}

export async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  const cli = request.cli ?? "codex";

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
    cli
  });

  // ── Cursor dispatch path ────────────────────────────────────────────────────
  // When --cli cursor is used, invoke Cursor ACP (`agent acp`).
  // The role (writer/planner/debugger/ask) is forwarded so the adapter can
  // prepend the appropriate slash-command prefix to the prompt.
  if (cli === "cursor") {
    const cursorAvail = cursor.adapter.isAvailable();
    if (!cursorAvail.available) {
      throw new Error(`Cursor agent CLI is not available: ${cursorAvail.detail ?? "agent not found"}. Install Cursor from https://cursor.com or set CURSOR_AGENT_PATH.`);
    }

    if (!request.prompt) {
      throw new Error("Provide a prompt for Cursor tasks.");
    }

    const prompt = request.prompt.trim() || "";

    const result = await cursor.adapter.invoke(workspaceRoot, prompt, {
      model: request.model ?? undefined,
      role: request.role ?? "writer",
      write: Boolean(request.write),
      onStream: request.onProgress
        ? (event) => {
            // message_chunk events are dropped from the stderr progress stream —
            // Cursor streams at token granularity and each chunk becomes its own
            // log line. The final text appears in the rendered output when the
            // task completes, so chunks are redundant noise. Phase events pass
            // through so the user sees "things happening" feedback.
            if (event.type === "phase") {
              request.onProgress({ message: event.message, phase: event.message });
            }
          }
        : undefined
    });

    const rawOutput = typeof result.text === "string" ? result.text : "";
    const failureMessage = formatAdapterError(result.error);
    // Match codex's pattern: surface in-protocol errors via the rendered failure
    // message, not via a non-zero exit code. A non-zero exit trips the forwarding
    // subagent's "if Bash fails, return nothing" rule and silently swallows it.
    const exitStatus = 0;

    const rendered = renderTaskResult(
      {
        rawOutput,
        failureMessage,
        reasoningSummary: []
      },
      {
        title: taskMetadata.title,
        jobId: request.jobId ?? null,
        write: Boolean(request.write)
      }
    );

    const payload = {
      status: exitStatus,
      threadId: result.sessionId ?? null,
      rawOutput,
      touchedFiles: (result.fileChanges ?? []).map((fc) => fc.path),
      reasoningSummary: []
    };

    return {
      exitStatus,
      threadId: result.sessionId ?? null,
      turnId: null,
      payload,
      rendered,
      summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
      jobTitle: taskMetadata.title,
      jobClass: "task",
      write: Boolean(request.write)
    };
  }

  // ── Antigravity dispatch path ───────────────────────────────────────────────
  // When --cli antigravity is used, invoke the Antigravity 2.0 desktop LS
  // (live-attach). Phase 1 ships a stub adapter; this branch proves the plumbing.
  if (cli === "antigravity") {
    const agAvail = antigravity.adapter.isAvailable();
    if (!agAvail.available) {
      throw new Error(`Antigravity is not available: ${agAvail.detail}`);
    }

    if (!request.prompt) {
      throw new Error("Provide a prompt for Antigravity tasks.");
    }

    const prompt = request.prompt.trim() || "";

    const result = await antigravity.adapter.invoke(workspaceRoot, prompt, {
      model: request.model ?? undefined,
      role: request.role ?? "researcher",
      write: false,
      onStream: request.onProgress
        ? (event) => {
            if (event.type === "phase") {
              request.onProgress({ message: event.message, phase: event.message });
            }
          }
        : undefined
    });

    const rawOutput = typeof result.text === "string" ? result.text : "";
    const failureMessage = formatAdapterError(result.error);
    const exitStatus = 0;

    const rendered = renderTaskResult(
      { rawOutput, failureMessage, reasoningSummary: [] },
      { title: taskMetadata.title, jobId: request.jobId ?? null, write: false }
    );

    const payload = {
      status: exitStatus,
      threadId: result.sessionId ?? null,
      rawOutput,
      touchedFiles: (result.fileChanges ?? []).map((fc) => fc.path),
      reasoningSummary: []
    };

    return {
      exitStatus,
      threadId: result.sessionId ?? null,
      turnId: null,
      payload,
      rendered,
      summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
      jobTitle: taskMetadata.title,
      jobClass: "task",
      write: false
    };
  }

  // ── Codex dispatch path (default) ───────────────────────────────────────────
  ensureCodexAvailable(request.cwd);

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const untilDone = Boolean(request.untilDone);
  const maxTurns = untilDone ? Math.max(1, request.maxTurns ?? DEFAULT_MAX_TURNS) : 1;

  // First-turn prompt; in autonomous mode prepend the protocol header so the
  // model knows the rules even when the prompt came from a --prompt-file plan.
  const initialPrompt = untilDone && request.prompt
    ? buildAutonomousInitialPrompt(request.prompt)
    : request.prompt;

  const sandbox = request.write ? "danger-full-access" : "read-only";
  const persistentThreadName = resumeThreadId
    ? null
    : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT);

  /** @type {Awaited<ReturnType<typeof runAppServerTurn>> | null} */
  let lastResult = null;
  let threadId = resumeThreadId;
  const aggregatedTurnMessages = [];
  const aggregatedTouchedFiles = new Set();
  const aggregatedReasoning = [];
  let stopReason = null;
  let turnCount = 0;

  while (turnCount < maxTurns) {
    const isFirstTurn = turnCount === 0;
    const turnPrompt = isFirstTurn ? initialPrompt : AUTONOMOUS_CONTINUATION_PROMPT;
    const turnResumeId = isFirstTurn ? resumeThreadId : threadId;

    if (untilDone && !isFirstTurn && request.onProgress) {
      request.onProgress({
        message: `Autonomous turn ${turnCount + 1} of ${maxTurns}: resuming thread ${threadId}.`,
        phase: "starting"
      });
    }

    const turnResult = await runAppServerTurn(workspaceRoot, {
      resumeThreadId: turnResumeId,
      prompt: turnPrompt,
      defaultPrompt: turnResumeId ? DEFAULT_CONTINUE_PROMPT : "",
      model: request.model,
      effort: request.effort,
      // Max permissions for write tasks: danger-full-access also grants network
      // access (needed for MCP/web tools). Read-only retains the read-only sandbox
      // so accidental writes are still blocked even though approvals are skipped.
      sandbox,
      onProgress: request.onProgress,
      persistThread: true,
      // Only set a thread name on the very first call when starting a fresh
      // thread; resumes (turn 2+ or --resume-last) keep their existing name.
      threadName: isFirstTurn && !turnResumeId ? persistentThreadName : null
    });

    turnCount += 1;
    lastResult = turnResult;
    threadId = turnResult.threadId ?? threadId;

    for (const f of turnResult.touchedFiles ?? []) aggregatedTouchedFiles.add(f);
    if (Array.isArray(turnResult.reasoningSummary)) {
      aggregatedReasoning.push(...turnResult.reasoningSummary);
    }
    const finalMessage = typeof turnResult.finalMessage === "string" ? turnResult.finalMessage : "";
    aggregatedTurnMessages.push({ turn: turnCount, message: finalMessage, status: turnResult.status });

    if (!untilDone) {
      stopReason = "single-turn";
      break;
    }
    if (turnResult.status !== 0) {
      stopReason = "error";
      break;
    }
    if (PLAN_COMPLETE_PATTERN.test(finalMessage)) {
      stopReason = "plan-complete";
      break;
    }
    if (turnCount >= maxTurns) {
      stopReason = "max-turns";
      break;
    }
    // No-progress detector: from turn 2 onward, if a turn produced no file
    // edits AND no command executions, the model is likely idling rather than
    // working. Stop instead of looping forever.
    if (turnCount > 1) {
      const fileChangeCount = turnResult.fileChanges?.length ?? 0;
      const commandCount = turnResult.commandExecutions?.length ?? 0;
      if (fileChangeCount === 0 && commandCount === 0) {
        stopReason = "no-progress";
        break;
      }
    }
  }

  const result = lastResult;
  const rawOutput = untilDone
    ? buildAutonomousRawOutput(aggregatedTurnMessages, { stopReason, turnCount, maxTurns })
    : (typeof result?.finalMessage === "string" ? result.finalMessage : "");
  const failureMessage = result?.error?.message ?? result?.stderr ?? "";
  const reasoningSummary = untilDone ? aggregatedReasoning : (result?.reasoningSummary ?? []);
  const touchedFiles = untilDone ? [...aggregatedTouchedFiles] : (result?.touchedFiles ?? []);
  // In autonomous mode we only flag exit failure on hard error from Codex;
  // hitting max-turns or no-progress without PLAN_COMPLETE returns the
  // partial work with exit 0 so the dispatcher doesn't discard it.
  const exitStatus = untilDone
    ? (stopReason === "error" ? (result?.status ?? 1) : 0)
    : (result?.status ?? 1);

  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: exitStatus,
    threadId: result?.threadId ?? null,
    rawOutput,
    touchedFiles,
    reasoningSummary,
    ...(untilDone ? { autonomous: { turns: turnCount, stopReason, maxTurns } } : {})
  };

  return {
    exitStatus,
    threadId: result?.threadId ?? null,
    turnId: result?.turnId ?? null,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

export function buildAutonomousRawOutput(turnMessages, { stopReason, turnCount, maxTurns }) {
  const sections = [];
  for (const { turn, message } of turnMessages) {
    const body = String(message ?? "").trim() || "_(no final message from this turn)_";
    sections.push(`### Turn ${turn}\n\n${body}`);
  }

  const footer = (() => {
    switch (stopReason) {
      case "plan-complete":
        return `\n\n---\nAutonomous run finished after ${turnCount} turn(s): model emitted ${PLAN_COMPLETE_SENTINEL}.`;
      case "error":
        return `\n\n---\nAutonomous run stopped after ${turnCount} turn(s): Codex returned an error. See last turn for details.`;
      case "max-turns":
        return `\n\n---\nAutonomous run stopped after ${turnCount} turn(s): hit --max-turns ceiling (${maxTurns}). Re-dispatch with --resume-last --until-done to continue.`;
      case "no-progress":
        return `\n\n---\nAutonomous run stopped after ${turnCount} turn(s): the last turn made no file edits and ran no commands. The model has likely finished or is stuck. Re-dispatch with --resume-last --until-done to continue if there is more to do.`;
      default:
        return "";
    }
  })();

  return `${sections.join("\n\n")}${footer}`.trim() + "\n";
}

export function buildTaskRunMetadata({ prompt, resumeLast = false, cli = "codex" }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const cliLabel = cli === "cursor" ? "Cursor"
                 : cli === "antigravity" ? "Antigravity"
                 : "Codex";
  const title = resumeLast ? `${cliLabel} Resume` : `${cliLabel} Task`;
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

export function renderQueuedTaskLaunch(payload) {
  if (payload.deduplicated) {
    return `${payload.title} is already running as ${payload.jobId} (deduplicated; an identical task was launched within the last ${Math.round((payload.dedupWindowMs ?? 0) / 1000)}s in this session). Check /multi:status ${payload.jobId} for progress.\n`;
  }
  return `${payload.title} started in the background as ${payload.jobId}. Check /multi:status ${payload.jobId} for progress.\n`;
}

const DEFAULT_TASK_DEDUP_WINDOW_MS = 60_000;

export function getTaskDedupWindowMs() {
  const raw = process.env.MULTI_CLI_TASK_DEDUP_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_TASK_DEDUP_WINDOW_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TASK_DEDUP_WINDOW_MS;
}

export function computeTaskFingerprint(request) {
  const hash = createHash("sha256");
  const components = [
    String(request.cli ?? "codex"),
    String(request.role ?? ""),
    request.write ? "write" : "read",
    request.resumeLast ? "resume" : "fresh",
    String(request.model ?? ""),
    String(request.effort ?? ""),
    String(request.prompt ?? "").trim()
  ];
  for (const component of components) {
    hash.update(component);
    hash.update("\x00");
  }
  return hash.digest("hex").slice(0, 32);
}

export function findActiveDuplicateBackgroundTask({ workspaceRoot, fingerprint, sessionId, windowMs }) {
  if (!fingerprint || windowMs <= 0) {
    return null;
  }
  const now = Date.now();
  const candidates = listJobs(workspaceRoot).filter((job) => {
    if (job.fingerprint !== fingerprint) return false;
    if (job.status !== "queued" && job.status !== "running") return false;
    if (sessionId && job.sessionId && job.sessionId !== sessionId) return false;
    const createdMs = Date.parse(job.createdAt ?? "");
    if (!Number.isFinite(createdMs)) return false;
    return now - createdMs <= windowMs;
  });
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort(
    (left, right) => Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? "")
  );
  return candidates[0];
}

function buildTaskJob(workspaceRoot, taskMetadata, write, cli = "codex") {
  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
  job.cli = cli;
  return job;
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, cli, role, untilDone, maxTurns }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    cli: cli ?? "codex",
    role: role ?? null,
    untilDone: Boolean(untilDone),
    maxTurns: maxTurns ?? null
  };
}

function readTaskPrompt(cwd, options, positionals) {
  let prompt = "";
  if (options["prompt-file"]) {
    prompt = fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ").trim();
  if (positionalPrompt) {
    prompt = prompt
      ? `${prompt.trimEnd()}\n\n${positionalPrompt}`
      : positionalPrompt;
  }

  return prompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "multi-cli-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request, options = {}) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request,
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {})
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

export async function handleTask(argv, context = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "role", "max-turns"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "read-only", "until-done"],
    aliasMap: {
      m: "model"
    }
  });

  const cli = context.cli ?? "codex";
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const untilDone = Boolean(options["until-done"]);
  const maxTurns = normalizeMaxTurns(options["max-turns"]);
  if (untilDone && cli !== "codex") {
    throw new Error(`--until-done is currently only supported for the codex CLI (got --cli ${cli}).`);
  }
  if (maxTurns != null && !untilDone) {
    throw new Error("--max-turns requires --until-done.");
  }
  // --read-only (from read-only research/explore subagents) maps to write: false
  const write = Boolean(options.write) && !Boolean(options["read-only"]);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast,
    cli
  });

  if (options.background) {
    if (cli === "codex") {
      ensureCodexAvailable(cwd);
    } else {
      // For non-codex CLIs, check binary availability via the adapter registry.
      const adapterMod = getAdapter(cli);
      const avail = (adapterMod.adapter ?? adapterMod).isAvailable?.();
      if (avail && !avail.available) {
        throw new Error(`${cli} CLI is not available: ${avail.detail}`);
      }
    }
    requireTaskRequest(prompt, resumeLast);

    const probeRequest = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: null,
      cli,
      role: options.role ?? null,
      untilDone,
      maxTurns
    });
    const fingerprint = computeTaskFingerprint(probeRequest);
    const dedupWindowMs = getTaskDedupWindowMs();
    const sessionId = process.env[SESSION_ID_ENV] ?? null;
    const duplicate = findActiveDuplicateBackgroundTask({
      workspaceRoot,
      fingerprint,
      sessionId,
      windowMs: dedupWindowMs
    });
    if (duplicate) {
      const dedupPayload = {
        jobId: duplicate.id,
        status: duplicate.status,
        title: duplicate.title,
        summary: duplicate.summary,
        logFile: duplicate.logFile ?? null,
        deduplicated: true,
        dedupWindowMs
      };
      outputCommandResult(dedupPayload, renderQueuedTaskLaunch(dedupPayload), options.json);
      return;
    }

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, cli);
    const request = { ...probeRequest, jobId: job.id };
    const { payload } = enqueueBackgroundTask(cwd, job, request, { fingerprint });
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, cli);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress,
        cli,
        role: options.role ?? null,
        untilDone,
        maxTurns
      }),
    { json: options.json }
  );
}

export async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { normalizeArgv, normalizeReasoningEffort, normalizeRequestedModel } from "./lib/task-options.mjs";
import { firstMeaningfulLine, shorten } from "./lib/text.mjs";
import * as codex from "./lib/adapters/codex.mjs";
import * as cursor from "./lib/adapters/cursor.mjs";
import * as antigravity from "./lib/adapters/antigravity.mjs";
import { ADAPTERS, getAdapter } from "./lib/adapters/registry.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/adapters/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
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

function buildAutonomousInitialPrompt(prompt) {
  const trimmed = String(prompt ?? "").trim();
  return trimmed ? `${AUTONOMOUS_PROTOCOL_HEADER}${trimmed}` : AUTONOMOUS_PROTOCOL_HEADER.trimEnd();
}

function normalizeMaxTurns(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--max-turns must be a positive integer, got "${value}".`);
  }
  return Math.floor(n);
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  Global flags:",
      "    --cli <codex|cursor|antigravity>   Select the CLI adapter (default: codex)",
      "  node scripts/multi-cli-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/multi-cli-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/multi-cli-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/multi-cli-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--until-done [--max-turns N]] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/multi-cli-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/multi-cli-companion.mjs result [job-id] [--json]",
      "  node scripts/multi-cli-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

// Format whatever a non-Codex adapter returned as `result.error` into a useful
// human string. Covers three shapes we've seen: Error instances, plain objects
// with a `.message` field (e.g. JSON-RPC errors `{code, message}`), and strings.
// Default `String(obj)` on plain objects produces "[object Object]" which hides
// the real failure — this helper is specifically to avoid that.
function formatAdapterError(err) {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err.message) {
    const prefix = typeof err.code === "number" ? `[${err.code}] ` : "";
    return `${prefix}${err.message}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  // Per-CLI detection via each adapter's isAvailable(). Reflects the live
  // provider set (codex, cursor, antigravity); drives the report's CLI list so
  // it never drifts from the ADAPTERS registry. Cursor/Antigravity detection is
  // best-effort and must never throw — guard each probe.
  const cliOrder = ["codex", "cursor", "antigravity"];
  const clis = cliOrder.map((name) => {
    // ADAPTERS[name] is the adapter module namespace; its `.adapter` object
    // carries the uniform isAvailable() probe (same shape dispatch uses).
    const adapter = ADAPTERS[name]?.adapter;
    let availability = { available: false, detail: "adapter not registered", version: null };
    if (adapter && typeof adapter.isAvailable === "function") {
      try {
        availability = adapter.isAvailable(cwd);
      } catch (error) {
        availability = {
          available: false,
          detail: `detection failed: ${error?.message ?? error}`,
          version: null
        };
      }
    }
    return {
      name,
      available: Boolean(availability?.available),
      detail: availability?.detail ?? "",
      version: availability?.version ?? null
    };
  });

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  const antigravityCli = clis.find((entry) => entry.name === "antigravity");
  if (antigravityCli && !antigravityCli.available) {
    nextSteps.push("Antigravity: install the Antigravity 2.0 desktop app, sign in, and keep it running (detection only; the LS transport lands in Phase 2).");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    clis,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /multi:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
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

function buildAutonomousRawOutput(turnMessages, { stopReason, turnCount, maxTurns }) {
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

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false, cli = "codex" }) {
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

function renderQueuedTaskLaunch(payload) {
  if (payload.deduplicated) {
    return `${payload.title} is already running as ${payload.jobId} (deduplicated; an identical task was launched within the last ${Math.round((payload.dedupWindowMs ?? 0) / 1000)}s in this session). Check /multi:status ${payload.jobId} for progress.\n`;
  }
  return `${payload.title} started in the background as ${payload.jobId}. Check /multi:status ${payload.jobId} for progress.\n`;
}

const DEFAULT_TASK_DEDUP_WINDOW_MS = 60_000;

function getTaskDedupWindowMs() {
  const raw = process.env.MULTI_CLI_TASK_DEDUP_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_TASK_DEDUP_WINDOW_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TASK_DEDUP_WINDOW_MS;
}

function computeTaskFingerprint(request) {
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

function findActiveDuplicateBackgroundTask({ workspaceRoot, fingerprint, sessionId, windowMs }) {
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

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      cliLabel: options.cliLabel ?? job.cli ?? "codex",
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
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

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
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

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv, context = {}) {
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

async function handleTaskWorker(argv) {
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

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const rawArgv = process.argv.slice(2);
  // Parse --cli <name> from the raw argv before splitting subcommand.
  // Default to 'codex' for backwards compatibility.
  const cliArgIndex = rawArgv.indexOf('--cli');
  const cliName = cliArgIndex !== -1 && rawArgv[cliArgIndex + 1]
    ? rawArgv[cliArgIndex + 1]
    : 'codex';
  // Validate early so users get a clear error.
  const _adapter = getAdapter(cliName); // eslint-disable-line no-unused-vars

  // Remove --cli <name> from argv before extracting subcommand. Guard
  // cliArgIndex so we don't drop argv[0] when --cli is absent (cliArgIndex=-1
  // would make cliArgIndex+1 === 0 and silently consume the subcommand).
  const filteredArgv = cliArgIndex >= 0
    ? rawArgv.filter((_, i) => i !== cliArgIndex && i !== cliArgIndex + 1)
    : rawArgv;
  const [subcommand, ...argv] = filteredArgv;
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv, { cli: cliName });
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

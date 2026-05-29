import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../args.mjs";
import { normalizeArgv } from "../task-options.mjs";
import { resolveWorkspaceRoot } from "../workspace.mjs";
import { getCodexAvailability, findLatestTaskThread } from "../adapters/codex.mjs";
import { generateJobId, listJobs } from "../state.mjs";
import { sortJobsNewestFirst } from "../job-control.mjs";
import {
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  runTrackedJob,
  SESSION_ID_ENV
} from "../tracked-jobs.mjs";

export const ROOT_DIR = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");

export function outputResult(value, asJson) {
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
export function formatAdapterError(err) {
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

export function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

export function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

export function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

export function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/multi:setup`.");
  }
}

export function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

export function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

export function findLatestResumableTaskJob(jobs) {
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

export async function resolveLatestTrackedTaskThread(cwd, options = {}) {
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

export function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

export function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
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

export function createTrackedProgress(job, options = {}) {
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

export async function runForegroundCommand(job, runner, options = {}) {
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

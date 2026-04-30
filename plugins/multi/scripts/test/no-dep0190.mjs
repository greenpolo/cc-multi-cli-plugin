#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const companionPath = path.resolve(__dirname, "..", "multi-cli-companion.mjs").replace(/\\/g, "/");
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const fakeJobId = `dep0190-fake-${process.pid}`;
const prompt = "echo dep0190 verification";

function commandLabel(args) {
  return `node ${path.relative(repoRoot, companionPath).replace(/\\/g, "/")} ${args.join(" ")}`;
}

function runCompanion(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [companionPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MULTI_CLI_TASK_DEDUP_MS: "0"
      },
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? 30000;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${commandLabel(args)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ args, status, signal, stdout, stderr, combined: `${stdout}${stderr}` });
    });
  });
}

function assertNoDep0190(result) {
  if (!/DEP0190/.test(result.combined)) {
    return;
  }
  const lines = result.combined
    .split(/\r?\n/)
    .filter((line) => line.includes("DEP0190"));
  throw new Error(`${commandLabel(result.args)} emitted DEP0190:\n${lines.join("\n")}`);
}

function assertExit(result, expectedStatuses) {
  if (expectedStatuses.includes(result.status)) {
    return;
  }
  throw new Error(
    `${commandLabel(result.args)} exited with ${result.status ?? `signal ${result.signal}`}\n` +
      `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`
  );
}

function parseJobId(result) {
  const match = result.combined.match(/\bas\s+([A-Za-z0-9._-]+)\b/);
  if (!match) {
    throw new Error(`Could not parse background job id from ${commandLabel(result.args)} output:\n${result.combined}`);
  }
  return match[1];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancelLaunchedJob(jobId) {
  let lastCancel = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const cancel = await runCompanion(["cancel", jobId]);
    assertNoDep0190(cancel);
    if (cancel.status === 0) {
      return;
    }
    lastCancel = cancel;
    if (!/No (active )?job found/.test(cancel.combined)) {
      assertExit(cancel, [0]);
    }
    await delay(500);
  }

  const status = await runCompanion(["status", jobId]);
  assertNoDep0190(status);
  if (/\|\s*(running|queued)\s*\|/.test(status.combined) || /\b(running|queued)\b/.test(status.combined)) {
    throw new Error(
      `Could not cancel ${jobId} after retries.\nLast cancel output:\n${lastCancel?.combined ?? ""}\nStatus:\n${status.combined}`
    );
  }
}

async function main() {
  const status = await runCompanion(["status"]);
  assertNoDep0190(status);
  assertExit(status, [0]);

  const fakeCancel = await runCompanion(["cancel", fakeJobId]);
  assertNoDep0190(fakeCancel);
  assertExit(fakeCancel, [1]);

  const task = await runCompanion(["task", "--background", "--write", "--role", "execute", prompt], {
    timeoutMs: 60000
  });
  assertNoDep0190(task);
  assertExit(task, [0]);

  const jobId = parseJobId(task);
  await cancelLaunchedJob(jobId);

  process.stdout.write(`no DEP0190 warnings detected; launched ${jobId} and checked cleanup cancel path\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message ?? error}\n`);
  process.exitCode = 1;
});

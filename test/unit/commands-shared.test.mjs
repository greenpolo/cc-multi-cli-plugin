import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  REVIEW_SCHEMA,
  ROOT_DIR,
  findLatestResumableTaskJob,
  formatAdapterError,
  getJobKindLabel
} from "../../plugins/multi/scripts/lib/commands/shared.mjs";

test("getJobKindLabel maps kinds to labels", () => {
  assert.equal(getJobKindLabel("adversarial-review", "review"), "adversarial-review");
  assert.equal(getJobKindLabel("adversarial-review", "task"), "adversarial-review");
  assert.equal(getJobKindLabel("review", "review"), "review");
  assert.equal(getJobKindLabel("task", "task"), "rescue");
  assert.equal(getJobKindLabel("rescue", "rescue"), "rescue");
});

test("findLatestResumableTaskJob returns the first resumable task job", () => {
  const job = {
    jobClass: "task",
    threadId: "thread-1",
    status: "completed"
  };
  assert.deepEqual(findLatestResumableTaskJob([job]), job);
});

test("findLatestResumableTaskJob skips queued/running, no-threadId, and non-task jobs", () => {
  const queued = { jobClass: "task", threadId: "t-q", status: "queued" };
  const running = { jobClass: "task", threadId: "t-r", status: "running" };
  const noThread = { jobClass: "task", threadId: null, status: "completed" };
  const nonTask = { jobClass: "review", threadId: "t-rev", status: "completed" };
  const winner = { jobClass: "task", threadId: "t-win", status: "failed" };

  // Input is assumed pre-sorted newest-first; the first match wins.
  assert.deepEqual(
    findLatestResumableTaskJob([queued, running, noThread, nonTask, winner]),
    winner
  );
});

test("findLatestResumableTaskJob returns null for an empty list", () => {
  assert.equal(findLatestResumableTaskJob([]), null);
});

test("formatAdapterError handles every shape", () => {
  assert.equal(formatAdapterError(null), "");
  assert.equal(formatAdapterError(undefined), "");
  assert.equal(formatAdapterError(0), "");
  assert.equal(formatAdapterError(""), "");
  assert.equal(formatAdapterError(new Error("boom")), "boom");
  assert.equal(formatAdapterError("plain string"), "plain string");
  assert.equal(formatAdapterError({ code: 42, message: "rpc failed" }), "[42] rpc failed");
  assert.equal(formatAdapterError({ message: "no code" }), "no code");
  assert.equal(formatAdapterError({ foo: "bar" }), JSON.stringify({ foo: "bar" }));
});

test("ROOT_DIR resolves to the scripts root and REVIEW_SCHEMA exists", () => {
  // This is the canary for a wrong ROOT_DIR base path. If ROOT_DIR pointed at
  // lib/ instead of scripts/, both of these existsSync checks would fail.
  assert.ok(
    fs.existsSync(path.join(ROOT_DIR, "scripts", "multi-cli-companion.mjs")),
    `expected ROOT_DIR (${ROOT_DIR}) to contain scripts/multi-cli-companion.mjs`
  );
  assert.ok(
    fs.existsSync(REVIEW_SCHEMA),
    `expected REVIEW_SCHEMA (${REVIEW_SCHEMA}) to exist`
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildAutonomousInitialPrompt,
  buildAutonomousRawOutput,
  buildTaskRunMetadata,
  computeTaskFingerprint,
  evaluateAutonomousStop,
  findActiveDuplicateBackgroundTask,
  getTaskDedupWindowMs,
  normalizeMaxTurns
} from "../../plugins/multi/scripts/lib/commands/task.mjs";
import { upsertJob } from "../../plugins/multi/scripts/lib/state.mjs";

test("normalizeMaxTurns parses, floors, and validates", () => {
  assert.equal(normalizeMaxTurns(null), null);
  assert.equal(normalizeMaxTurns(""), null);
  assert.equal(normalizeMaxTurns("5"), 5);
  assert.equal(normalizeMaxTurns(5.9), 5);
  assert.throws(() => normalizeMaxTurns("0"), /must be a positive integer/);
  assert.throws(() => normalizeMaxTurns("-3"), /must be a positive integer/);
  assert.throws(() => normalizeMaxTurns("abc"), /must be a positive integer/);
});

test("buildAutonomousInitialPrompt prepends the protocol header to a prompt", () => {
  const prompt = buildAutonomousInitialPrompt("Refactor the parser.");
  assert.match(prompt, /AUTONOMOUS MODE/);
  assert.match(prompt, /PLAN COMPLETE/);
  assert.ok(prompt.endsWith("Refactor the parser."));
});

test("buildAutonomousInitialPrompt returns trimmed header when prompt is empty", () => {
  const prompt = buildAutonomousInitialPrompt("   ");
  assert.match(prompt, /AUTONOMOUS MODE/);
  // No prompt body appended and no trailing blank line.
  assert.ok(!prompt.endsWith("\n"));
});

test("buildAutonomousRawOutput renders turn sections with a single trailing newline", () => {
  const out = buildAutonomousRawOutput(
    [
      { turn: 1, message: "Did the first thing." },
      { turn: 2, message: "Did the second thing." }
    ],
    { stopReason: "plan-complete", turnCount: 2, maxTurns: 30 }
  );
  assert.match(out, /### Turn 1\n\nDid the first thing\./);
  assert.match(out, /### Turn 2\n\nDid the second thing\./);
  // Single trailing newline.
  assert.ok(out.endsWith("\n"));
  assert.ok(!out.endsWith("\n\n"));
});

test("buildAutonomousRawOutput uses placeholder for empty turn messages", () => {
  const out = buildAutonomousRawOutput(
    [{ turn: 1, message: "" }],
    { stopReason: "single-turn", turnCount: 1, maxTurns: 1 }
  );
  assert.match(out, /_\(no final message from this turn\)_/);
});

test("buildAutonomousRawOutput emits the matching footer per stopReason", () => {
  const planComplete = buildAutonomousRawOutput(
    [{ turn: 1, message: "x" }],
    { stopReason: "plan-complete", turnCount: 1, maxTurns: 30 }
  );
  assert.match(planComplete, /model emitted PLAN COMPLETE/);

  const error = buildAutonomousRawOutput(
    [{ turn: 1, message: "x" }],
    { stopReason: "error", turnCount: 1, maxTurns: 30 }
  );
  assert.match(error, /Codex returned an error/);

  const maxTurns = buildAutonomousRawOutput(
    [{ turn: 1, message: "x" }],
    { stopReason: "max-turns", turnCount: 3, maxTurns: 3 }
  );
  assert.match(maxTurns, /hit --max-turns ceiling \(3\)/);

  const noProgress = buildAutonomousRawOutput(
    [{ turn: 1, message: "x" }],
    { stopReason: "no-progress", turnCount: 2, maxTurns: 30 }
  );
  assert.match(noProgress, /made no file edits and ran no commands/);

  const none = buildAutonomousRawOutput(
    [{ turn: 1, message: "x" }],
    { stopReason: "single-turn", turnCount: 1, maxTurns: 1 }
  );
  assert.ok(!none.includes("---"));
});

test("buildAutonomousRawOutput error footer honors a custom cliLabel", () => {
  const codex = buildAutonomousRawOutput(
    [{ turn: 1, message: "x" }],
    { stopReason: "error", turnCount: 1, maxTurns: 30 }
  );
  assert.match(codex, /Codex returned an error/);
  const cursor = buildAutonomousRawOutput(
    [{ turn: 1, message: "x" }],
    { stopReason: "error", turnCount: 1, maxTurns: 30, cliLabel: "Cursor" }
  );
  assert.match(cursor, /Cursor returned an error/);
});

// ── evaluateAutonomousStop (shared codex/cursor stop ladder) ───────────────────

test("evaluateAutonomousStop: non-autonomous run always stops after one turn", () => {
  assert.equal(
    evaluateAutonomousStop({ status: 0, finalMessage: "anything" }, { untilDone: false, turnCount: 1, maxTurns: 1 }),
    "single-turn"
  );
});

test("evaluateAutonomousStop: a non-zero status stops with 'error' before anything else", () => {
  // Error precedence: even with a PLAN COMPLETE line present, a failed turn is an error.
  assert.equal(
    evaluateAutonomousStop(
      { status: 1, finalMessage: "PLAN COMPLETE" },
      { untilDone: true, turnCount: 2, maxTurns: 30 }
    ),
    "error"
  );
});

test("evaluateAutonomousStop: a PLAN COMPLETE line stops with 'plan-complete'", () => {
  assert.equal(
    evaluateAutonomousStop(
      { status: 0, finalMessage: "did the work\nPLAN COMPLETE\n" },
      { untilDone: true, turnCount: 1, maxTurns: 30 }
    ),
    "plan-complete"
  );
  // plan-complete is checked before the max-turns ceiling.
  assert.equal(
    evaluateAutonomousStop(
      { status: 0, finalMessage: "PLAN COMPLETE" },
      { untilDone: true, turnCount: 5, maxTurns: 5 }
    ),
    "plan-complete"
  );
});

test("evaluateAutonomousStop: hitting the max-turns ceiling stops with 'max-turns'", () => {
  assert.equal(
    evaluateAutonomousStop(
      { status: 0, finalMessage: "still going", fileChanges: [{ path: "a" }] },
      { untilDone: true, turnCount: 3, maxTurns: 3 }
    ),
    "max-turns"
  );
});

test("evaluateAutonomousStop: no edits and no commands from turn 2+ stops with 'no-progress'", () => {
  assert.equal(
    evaluateAutonomousStop(
      { status: 0, finalMessage: "thinking out loud", fileChanges: [], commandExecutions: [] },
      { untilDone: true, turnCount: 2, maxTurns: 30 }
    ),
    "no-progress"
  );
  // Progress (a file change) keeps the loop going.
  assert.equal(
    evaluateAutonomousStop(
      { status: 0, finalMessage: "edited", fileChanges: [{ path: "a" }], commandExecutions: [] },
      { untilDone: true, turnCount: 2, maxTurns: 30 }
    ),
    null
  );
  // The no-progress detector does not fire on the very first turn.
  assert.equal(
    evaluateAutonomousStop(
      { status: 0, finalMessage: "warming up", fileChanges: [], commandExecutions: [] },
      { untilDone: true, turnCount: 1, maxTurns: 30 }
    ),
    null
  );
});

test("buildTaskRunMetadata detects the stop-gate review marker when not resuming", () => {
  const marker = "Run a stop-gate review of the previous Claude turn.";
  assert.deepEqual(
    buildTaskRunMetadata({ prompt: `${marker} please`, resumeLast: false, cli: "codex" }),
    {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    }
  );
  // resumeLast bypasses the marker branch.
  const resumed = buildTaskRunMetadata({ prompt: `${marker} please`, resumeLast: true, cli: "codex" });
  assert.equal(resumed.title, "Codex Resume");
});

test("buildTaskRunMetadata labels titles per cli", () => {
  assert.equal(buildTaskRunMetadata({ prompt: "do work", cli: "codex" }).title, "Codex Task");
  assert.equal(buildTaskRunMetadata({ prompt: "do work", cli: "cursor" }).title, "Cursor Task");
  assert.equal(buildTaskRunMetadata({ prompt: "do work", cli: "antigravity" }).title, "Antigravity Task");
});

test("buildTaskRunMetadata falls back to the continue prompt summary on resume", () => {
  const meta = buildTaskRunMetadata({ prompt: "", resumeLast: true, cli: "codex" });
  assert.equal(meta.title, "Codex Resume");
  assert.match(meta.summary, /Continue from the current thread state/);
});

test("computeTaskFingerprint is a deterministic 32-hex digest", () => {
  const request = {
    cli: "codex",
    role: "writer",
    write: true,
    resumeLast: false,
    model: "spark",
    effort: "high",
    prompt: "Fix the bug."
  };
  const a = computeTaskFingerprint(request);
  const b = computeTaskFingerprint({ ...request });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test("computeTaskFingerprint differs when any component changes", () => {
  const base = {
    cli: "codex",
    role: "writer",
    write: true,
    resumeLast: false,
    model: "spark",
    effort: "high",
    prompt: "Fix the bug."
  };
  const baseFp = computeTaskFingerprint(base);
  assert.notEqual(baseFp, computeTaskFingerprint({ ...base, cli: "cursor" }));
  assert.notEqual(baseFp, computeTaskFingerprint({ ...base, role: "planner" }));
  assert.notEqual(baseFp, computeTaskFingerprint({ ...base, write: false }));
  assert.notEqual(baseFp, computeTaskFingerprint({ ...base, resumeLast: true }));
  assert.notEqual(baseFp, computeTaskFingerprint({ ...base, model: "other" }));
  assert.notEqual(baseFp, computeTaskFingerprint({ ...base, effort: "low" }));
  assert.notEqual(baseFp, computeTaskFingerprint({ ...base, prompt: "Different." }));
});

test("computeTaskFingerprint trims the prompt", () => {
  const a = computeTaskFingerprint({ prompt: "hello" });
  const b = computeTaskFingerprint({ prompt: "  hello  " });
  assert.equal(a, b);
});

test("getTaskDedupWindowMs reads MULTI_CLI_TASK_DEDUP_MS with a default", () => {
  const original = process.env.MULTI_CLI_TASK_DEDUP_MS;
  try {
    delete process.env.MULTI_CLI_TASK_DEDUP_MS;
    assert.equal(getTaskDedupWindowMs(), 60000);

    process.env.MULTI_CLI_TASK_DEDUP_MS = "30000";
    assert.equal(getTaskDedupWindowMs(), 30000);

    process.env.MULTI_CLI_TASK_DEDUP_MS = "0";
    assert.equal(getTaskDedupWindowMs(), 0);

    process.env.MULTI_CLI_TASK_DEDUP_MS = "not-a-number";
    assert.equal(getTaskDedupWindowMs(), 60000);
  } finally {
    if (original === undefined) {
      delete process.env.MULTI_CLI_TASK_DEDUP_MS;
    } else {
      process.env.MULTI_CLI_TASK_DEDUP_MS = original;
    }
  }
});

test("findActiveDuplicateBackgroundTask returns null without a fingerprint or window", () => {
  assert.equal(
    findActiveDuplicateBackgroundTask({ workspaceRoot: "/tmp/nope", fingerprint: "", sessionId: null, windowMs: 60000 }),
    null
  );
  assert.equal(
    findActiveDuplicateBackgroundTask({ workspaceRoot: "/tmp/nope", fingerprint: "abc", sessionId: null, windowMs: 0 }),
    null
  );
});

test("findActiveDuplicateBackgroundTask matches active same-fingerprint jobs in window", () => {
  const originalPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "multi-cli-dedup-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-cli-ws-"));
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    const fingerprint = "fp-active";
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();

    // queued, in-window, matching session → candidate
    upsertJob(workspaceRoot, {
      id: "task-queued",
      fingerprint,
      status: "queued",
      sessionId: "sess-1",
      createdAt: iso(5_000)
    });
    // running, in-window, newer → should win over the queued one
    upsertJob(workspaceRoot, {
      id: "task-running-newest",
      fingerprint,
      status: "running",
      sessionId: "sess-1",
      createdAt: iso(1_000)
    });
    // completed (inactive) → rejected
    upsertJob(workspaceRoot, {
      id: "task-completed",
      fingerprint,
      status: "completed",
      sessionId: "sess-1",
      createdAt: iso(2_000)
    });
    // other session → rejected
    upsertJob(workspaceRoot, {
      id: "task-other-session",
      fingerprint,
      status: "running",
      sessionId: "sess-2",
      createdAt: iso(500)
    });
    // stale (outside window) → rejected
    upsertJob(workspaceRoot, {
      id: "task-stale",
      fingerprint,
      status: "running",
      sessionId: "sess-1",
      createdAt: iso(120_000)
    });
    // different fingerprint → rejected
    upsertJob(workspaceRoot, {
      id: "task-other-fp",
      fingerprint: "fp-different",
      status: "running",
      sessionId: "sess-1",
      createdAt: iso(100)
    });

    const match = findActiveDuplicateBackgroundTask({
      workspaceRoot,
      fingerprint,
      sessionId: "sess-1",
      windowMs: 60_000
    });
    assert.ok(match, "expected a duplicate match");
    assert.equal(match.id, "task-running-newest");

    // No fingerprint match → null
    assert.equal(
      findActiveDuplicateBackgroundTask({
        workspaceRoot,
        fingerprint: "fp-nope",
        sessionId: "sess-1",
        windowMs: 60_000
      }),
      null
    );
  } finally {
    if (originalPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = originalPluginData;
    }
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

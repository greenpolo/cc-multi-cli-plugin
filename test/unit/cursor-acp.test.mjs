// Offline tests for the Cursor ACP transport path (MULTI_TRANSPORT_CURSOR=acp).
// Drives adapter.invoke() / runAcpCursorTurn against the fake ACP agent fixture
// via an injected spawnSpec (the role resolve.mjs env overrides serve in
// production) so no real CLI is spawned. Asserts: transport selection honors the
// env flag and defaults to headless; sessionMode by role (ask vs agent); model
// alias resolution (exact, prefix-unique, ambiguous→error, missing→error with
// list); result-shape parity with headless; cancel routing.

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  cursorTransport,
  acpSessionModeForRole,
  resolveCursorModel,
  invokeCursor,
  runAcpCursorTurn,
  cancelCursor,
  cancelAcpCursor,
  mapAcpUpdateToProgress,
  adapter
} from "../../plugins/multi/scripts/lib/adapters/cursor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const FIXTURE = path.join(repoRoot, "test", "fixtures", "fake-acp-agent.mjs");
const NODE = process.execPath;

const COMPOSITE_IDS = ["composer-2.5[fast=true]", "gpt-5.5[context=272k,reasoning=medium,fast=false]", "claude-opus-4-8[thinking=high]"];

function fixtureSpawnSpec(flags) {
  return { exe: NODE, args: [FIXTURE, ...flags] };
}
function tmpRecord() {
  return path.join(os.tmpdir(), `cur-acp-rec-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
}
function readRecord(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
function withTransport(value, fn) {
  const prev = process.env.MULTI_TRANSPORT_CURSOR;
  if (value === undefined) delete process.env.MULTI_TRANSPORT_CURSOR;
  else process.env.MULTI_TRANSPORT_CURSOR = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.MULTI_TRANSPORT_CURSOR;
      else process.env.MULTI_TRANSPORT_CURSOR = prev;
    });
}

// ── transport selection ───────────────────────────────────────────────────────

test("cursorTransport: defaults to headless; 'acp' (any case) selects acp", () => {
  assert.equal(cursorTransport({}), "headless");
  assert.equal(cursorTransport({ MULTI_TRANSPORT_CURSOR: "headless" }), "headless");
  assert.equal(cursorTransport({ MULTI_TRANSPORT_CURSOR: "acp" }), "acp");
  assert.equal(cursorTransport({ MULTI_TRANSPORT_CURSOR: "ACP" }), "acp");
  assert.equal(cursorTransport({ MULTI_TRANSPORT_CURSOR: " acp " }), "acp");
  assert.equal(cursorTransport({ MULTI_TRANSPORT_CURSOR: "nope" }), "headless");
});

test("invokeCursor defaults to the headless path when no flag is set", async () => {
  await withTransport(undefined, async () => {
    const prevPath = process.env.CURSOR_AGENT_PATH;
    process.env.CURSOR_AGENT_PATH = path.join(os.tmpdir(), "definitely-not-a-real-cursor-agent.cmd");
    try {
      const res = await invokeCursor(repoRoot, "hi", { role: "explore" });
      assert.ok(res.error, "headless path resolves with an error for a missing binary");
      assert.ok(!/ACP runtime not found/i.test(res.error.message ?? ""), "did not take the ACP path");
    } finally {
      if (prevPath === undefined) delete process.env.CURSOR_AGENT_PATH;
      else process.env.CURSOR_AGENT_PATH = prevPath;
    }
  });
});

// ── session mode by role ──────────────────────────────────────────────────────

test("acpSessionModeForRole: read-only → ask; write/delegate → agent", () => {
  for (const r of ["research", "researcher", "explore", "explorer", "ask", "plan", "planner"]) {
    assert.equal(acpSessionModeForRole(r), "ask", `${r} → ask`);
  }
  for (const r of ["delegate", "writer", "debugger"]) {
    assert.equal(acpSessionModeForRole(r), "agent", `${r} → agent`);
  }
});

test("ACP path: read-only role sets session mode 'ask'", async () => {
  const rec = tmpRecord();
  try {
    const res = await runAcpCursorTurn(repoRoot, "what is here", {
      role: "explore",
      spawnSpec: fixtureSpawnSpec(["--modes", "ask,agent,plan", "--record", rec, "--stream", "ok"])
    });
    assert.equal(res.error, null);
    const setMode = readRecord(rec).find((l) => "set_mode" in l);
    assert.ok(setMode, "session/set_mode was sent");
    assert.equal(setMode.set_mode, "ask");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

test("ACP path: delegate role sets session mode 'agent' and allows writes", async () => {
  const rec = tmpRecord();
  try {
    // --permission makes the fake agent ask; allowWrites (write role) → allow_once.
    await runAcpCursorTurn(repoRoot, "write code", {
      role: "delegate",
      spawnSpec: fixtureSpawnSpec(["--modes", "ask,agent", "--permission", "--record", rec, "--stream", "ok"])
    });
    const lines = readRecord(rec);
    const setMode = lines.find((l) => "set_mode" in l);
    assert.equal(setMode.set_mode, "agent");
    const outcome = lines.find((l) => "permission_outcome" in l)?.permission_outcome;
    assert.equal(outcome.outcome, "selected");
    assert.equal(outcome.optionId, "allow-once", "write role allows the tool");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

// ── model alias resolution (pure) ─────────────────────────────────────────────

test("resolveCursorModel: no requested model → {value: undefined} (do not pin)", () => {
  assert.deepEqual(resolveCursorModel(COMPOSITE_IDS, undefined), { value: undefined });
  assert.deepEqual(resolveCursorModel(COMPOSITE_IDS, "   "), { value: undefined });
});

test("resolveCursorModel: exact composite id matches verbatim", () => {
  assert.deepEqual(resolveCursorModel(COMPOSITE_IDS, "composer-2.5[fast=true]"), {
    value: "composer-2.5[fast=true]"
  });
});

test("resolveCursorModel: unique prefix match on the segment before '['", () => {
  assert.deepEqual(resolveCursorModel(COMPOSITE_IDS, "composer-2.5"), { value: "composer-2.5[fast=true]" });
  assert.deepEqual(resolveCursorModel(COMPOSITE_IDS, "gpt-5.5"), {
    value: "gpt-5.5[context=272k,reasoning=medium,fast=false]"
  });
});

test("resolveCursorModel: ambiguous prefix → error listing the matches", () => {
  const ids = ["composer-2.5[fast=true]", "composer-2.5[fast=false]"];
  const r = resolveCursorModel(ids, "composer-2.5");
  assert.ok(r.error, "ambiguity is an error");
  assert.equal(r.error.code, "config");
  assert.match(r.error.message, /ambiguous/i);
  assert.match(r.error.detail, /fast=true/);
  assert.match(r.error.detail, /fast=false/);
});

test("resolveCursorModel: no match → error listing available ids", () => {
  const r = resolveCursorModel(COMPOSITE_IDS, "gemini-3-pro");
  assert.ok(r.error);
  assert.equal(r.error.code, "config");
  assert.match(r.error.message, /not offered/i);
  assert.match(r.error.detail, /composer-2\.5/);
});

test("resolveCursorModel: empty live list → pass requested value through (best-effort)", () => {
  assert.deepEqual(resolveCursorModel([], "composer-2.5"), { value: "composer-2.5" });
});

// ── model resolution end-to-end through runAcpTurn ────────────────────────────

test("ACP path: prefix-resolved model is pinned via set_config_option with the composite id", async () => {
  const rec = tmpRecord();
  try {
    const res = await runAcpCursorTurn(repoRoot, "hi", {
      role: "delegate",
      model: "composer-2.5",
      spawnSpec: fixtureSpawnSpec(["--models", COMPOSITE_IDS.join(","), "--record", rec, "--stream", "ok"])
    });
    assert.equal(res.error, null);
    const setConfig = readRecord(rec).find((l) => "set_config" in l);
    assert.ok(setConfig, "set_config_option was sent");
    assert.equal(setConfig.set_config.value, "composer-2.5[fast=true]", "the exact composite id is pinned");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

test("ACP path: an unresolvable model fails before prompting with the available list", async () => {
  const rec = tmpRecord();
  try {
    const res = await runAcpCursorTurn(repoRoot, "hi", {
      role: "delegate",
      model: "no-such-model",
      spawnSpec: fixtureSpawnSpec(["--models", COMPOSITE_IDS.join(","), "--record", rec])
    });
    assert.ok(res.error, "an error is set");
    assert.equal(res.status, 1);
    assert.match(res.error.message, /no-such-model|not offered/i);
    assert.match(res.error.message, /composer-2\.5/);
    const lines = readRecord(rec);
    assert.ok(!lines.some((l) => l.recv === "session/prompt"), "no prompt sent on an unresolvable model");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

test("ACP path: an ambiguous model fails before prompting", async () => {
  const ids = ["composer-2.5[fast=true]", "composer-2.5[fast=false]"];
  const rec = tmpRecord();
  try {
    const res = await runAcpCursorTurn(repoRoot, "hi", {
      role: "delegate",
      model: "composer-2.5",
      spawnSpec: fixtureSpawnSpec(["--models", ids.join(","), "--record", rec])
    });
    assert.ok(res.error);
    assert.match(res.error.message, /ambiguous/i);
    const lines = readRecord(rec);
    assert.ok(!lines.some((l) => l.recv === "session/prompt"), "no prompt sent on ambiguity");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

// ── result-shape parity + stream mapping ──────────────────────────────────────

test("ACP path: happy turn returns the headless result shape (render-consumed keys)", async () => {
  const res = await runAcpCursorTurn(repoRoot, "hi", {
    role: "explore",
    spawnSpec: fixtureSpawnSpec(["--modes", "ask,agent", "--stream", "spaced ok"])
  });
  assert.equal(res.error, null);
  assert.equal(res.text, "spaced ok");
  assert.equal(res.status, 0);
  for (const k of ["sessionId", "text", "error", "status", "fileChanges", "commandExecutions", "toolCalls"]) {
    assert.ok(k in res, `result must carry ${k}`);
  }
});

test("mapAcpUpdateToProgress: message chunk → message_chunk; tool_call → phase", () => {
  assert.deepEqual(
    mapAcpUpdateToProgress({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
    { type: "message_chunk", text: "hi" }
  );
  const phase = mapAcpUpdateToProgress({ sessionUpdate: "tool_call", kind: "edit" });
  assert.equal(phase.type, "phase");
  assert.match(phase.message, /Cursor/);
  assert.equal(mapAcpUpdateToProgress(null), null);
});

// ── cancel routing ────────────────────────────────────────────────────────────

test("cancelCursor: headless transport (default) reports process-tree", async () => {
  await withTransport(undefined, async () => {
    const res = await cancelCursor("job-cur-1");
    assert.equal(res.transport, "process-tree");
    assert.match(res.detail, /job-cur-1/);
  });
});

test("cancelCursor: acp transport with no in-flight turn reports process-tree (cross-process backstop)", async () => {
  await withTransport("acp", async () => {
    const res = await cancelCursor("job-cur-2");
    assert.equal(res.transport, "process-tree");
    assert.equal(res.interrupted, false);
  });
});

test("ACP cancel routes to the in-flight turn handle", async () => {
  const jobId = "job-cur-inflight";
  const p = runAcpCursorTurn(repoRoot, "hi", {
    role: "delegate",
    jobId,
    spawnSpec: fixtureSpawnSpec(["--cancel-mode", "ignore", "--stream", ""])
  });
  await new Promise((r) => setTimeout(r, 400));
  const cancelRes = await cancelAcpCursor(jobId);
  assert.equal(cancelRes.transport, "acp");
  assert.equal(cancelRes.interrupted, true, "in-flight handle was found and cancelled");
  await p;
});

// ── contract shape still intact ───────────────────────────────────────────────

test("adapter still conforms (name cursor, invoke/cancel functions)", () => {
  assert.equal(adapter.name, "cursor");
  assert.equal(typeof adapter.invoke, "function");
  assert.equal(typeof adapter.cancel, "function");
  assert.equal(adapter.getSession, undefined);
});

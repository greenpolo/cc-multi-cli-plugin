// Offline tests for the OpenCode ACP transport path (MULTI_TRANSPORT_OPENCODE=acp).
// Drives adapter.invoke() / runAcpOpencodeTurn against the fake ACP agent fixture
// (test/fixtures/fake-acp-agent.mjs) via an injected spawnSpec — the same role the
// resolve.mjs env overrides serve in production — so no real CLI is spawned and
// every case runs deterministically. Asserts: transport selection honors the env
// flag and defaults to headless; the read-only OPENCODE_PERMISSION deny floor and
// the model pass through; result-shape parity with the headless path; cancel
// routing through the in-flight ACP turn handle.

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  opencodeTransport,
  invokeOpencode,
  runAcpOpencodeTurn,
  cancelOpencode,
  cancelAcpOpencode,
  mapAcpUpdateToProgress,
  READ_ONLY_PERMISSION_FLOOR,
  adapter
} from "../../plugins/multi/scripts/lib/adapters/opencode.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const FIXTURE = path.join(repoRoot, "test", "fixtures", "fake-acp-agent.mjs");
const NODE = process.execPath;

function fixtureSpawnSpec(flags) {
  return { exe: NODE, args: [FIXTURE, ...flags] };
}
function tmpRecord() {
  return path.join(os.tmpdir(), `oc-acp-rec-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
}
function readRecord(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
function withTransport(value, fn) {
  const prev = process.env.MULTI_TRANSPORT_OPENCODE;
  if (value === undefined) delete process.env.MULTI_TRANSPORT_OPENCODE;
  else process.env.MULTI_TRANSPORT_OPENCODE = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.MULTI_TRANSPORT_OPENCODE;
      else process.env.MULTI_TRANSPORT_OPENCODE = prev;
    });
}

// ── transport selection ───────────────────────────────────────────────────────

test("opencodeTransport: defaults to headless; 'acp' (any case) selects acp", () => {
  assert.equal(opencodeTransport({}), "headless");
  assert.equal(opencodeTransport({ MULTI_TRANSPORT_OPENCODE: "" }), "headless");
  assert.equal(opencodeTransport({ MULTI_TRANSPORT_OPENCODE: "headless" }), "headless");
  assert.equal(opencodeTransport({ MULTI_TRANSPORT_OPENCODE: "acp" }), "acp");
  assert.equal(opencodeTransport({ MULTI_TRANSPORT_OPENCODE: "ACP" }), "acp");
  assert.equal(opencodeTransport({ MULTI_TRANSPORT_OPENCODE: "  acp  " }), "acp");
  assert.equal(opencodeTransport({ MULTI_TRANSPORT_OPENCODE: "garbage" }), "headless");
});

test("invokeOpencode defaults to the headless path when no flag is set", async () => {
  // With no flag and a non-existent binary override, the headless path is taken:
  // it spawns the (missing) CLI and resolves with an error result — NOT the ACP
  // missing-runtime message. Proves selection logic routes to headless by default.
  await withTransport(undefined, async () => {
    const prevPath = process.env.OPENCODE_CLI_PATH;
    process.env.OPENCODE_CLI_PATH = path.join(os.tmpdir(), "definitely-not-a-real-opencode-binary.cmd");
    try {
      const res = await invokeOpencode(repoRoot, "hi", { role: "explore" });
      assert.ok(res.error, "headless path resolves with an error for a missing binary");
      // The ACP path's missing-runtime message would mention 'ACP'; headless does not.
      assert.ok(!/ACP executable not found/i.test(res.error.message ?? ""), "did not take the ACP path");
    } finally {
      if (prevPath === undefined) delete process.env.OPENCODE_CLI_PATH;
      else process.env.OPENCODE_CLI_PATH = prevPath;
    }
  });
});

// ── happy path + result-shape parity ──────────────────────────────────────────

test("ACP path: happy turn returns the headless result shape (text/error/sessionId/status/arrays)", async () => {
  const res = await runAcpOpencodeTurn(repoRoot, "do the thing", {
    role: "delegate",
    spawnSpec: fixtureSpawnSpec(["--stream", "Hello |ACP |world"])
  });
  assert.equal(res.error, null);
  assert.equal(res.text, "Hello ACP world");
  assert.equal(res.status, 0);
  assert.ok(res.sessionId, "sessionId captured");
  // Same keys the render layer consumes as the headless outcome.
  for (const k of ["sessionId", "text", "error", "status", "fileChanges", "commandExecutions", "toolCalls"]) {
    assert.ok(k in res, `result must carry ${k} (render-consumed key)`);
  }
  assert.deepEqual(res.fileChanges, []);
  assert.deepEqual(res.commandExecutions, []);
  assert.deepEqual(res.toolCalls, []);
});

// ── read-only deny env passes through ─────────────────────────────────────────

test("ACP path: read-only role applies the OPENCODE_PERMISSION deny floor to the spawn env", async () => {
  const rec = tmpRecord();
  try {
    const res = await runAcpOpencodeTurn(repoRoot, "look around", {
      role: "explore",
      spawnSpec: fixtureSpawnSpec(["--echo-env", "OPENCODE_PERMISSION", "--record", rec, "--stream", "ok"])
    });
    assert.equal(res.error, null);
    const lines = readRecord(rec);
    const echoed = lines.find((l) => "env_OPENCODE_PERMISSION" in l)?.env_OPENCODE_PERMISSION;
    assert.ok(echoed, "the spawn env carried OPENCODE_PERMISSION");
    // Exactly the headless deny preset (the same constant, not a duplicated JSON).
    assert.equal(echoed, READ_ONLY_PERMISSION_FLOOR);
    const floor = JSON.parse(echoed);
    assert.equal(floor.edit, "deny");
    assert.equal(floor.bash, "deny");
    assert.equal(floor.write, "deny");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

test("ACP path: write/delegate role does NOT set the deny floor", async () => {
  const rec = tmpRecord();
  try {
    await runAcpOpencodeTurn(repoRoot, "write code", {
      role: "delegate",
      spawnSpec: fixtureSpawnSpec(["--echo-env", "OPENCODE_PERMISSION", "--record", rec, "--stream", "ok"])
    });
    const lines = readRecord(rec);
    const echoed = lines.find((l) => "env_OPENCODE_PERMISSION" in l)?.env_OPENCODE_PERMISSION;
    assert.equal(echoed, null, "write role must not inject the read-only deny floor");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

// ── model passes through ──────────────────────────────────────────────────────

test("ACP path: the model is set via set_config_option (provider/model id passes through)", async () => {
  const rec = tmpRecord();
  try {
    const res = await runAcpOpencodeTurn(repoRoot, "hi", {
      role: "delegate",
      model: "opencode/gpt-5-nano",
      spawnSpec: fixtureSpawnSpec([
        "--models", "opencode/claude-opus-4-8,opencode/gpt-5-nano",
        "--record", rec,
        "--stream", "ok"
      ])
    });
    assert.equal(res.error, null);
    const setConfig = readRecord(rec).find((l) => "set_config" in l);
    assert.ok(setConfig, "set_config_option was sent");
    assert.equal(setConfig.set_config.configId, "model");
    assert.equal(setConfig.set_config.value, "opencode/gpt-5-nano");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

test("ACP path: a model not in the live list fails before prompting (no silent fallback)", async () => {
  const rec = tmpRecord();
  try {
    const res = await runAcpOpencodeTurn(repoRoot, "hi", {
      role: "delegate",
      model: "openai/does-not-exist",
      spawnSpec: fixtureSpawnSpec(["--models", "opencode/claude-opus-4-8,opencode/gpt-5-nano", "--record", rec])
    });
    assert.ok(res.error, "an error is set");
    assert.equal(res.status, 1);
    assert.match(res.error.message, /does-not-exist/);
    const lines = readRecord(rec);
    assert.ok(!lines.some((l) => l.recv === "session/prompt"), "no prompt sent on an invalid model");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

// ── stream mapping ────────────────────────────────────────────────────────────

test("mapAcpUpdateToProgress: message chunk → message_chunk; tool_call → phase; else null", () => {
  assert.deepEqual(
    mapAcpUpdateToProgress({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
    { type: "message_chunk", text: "hi" }
  );
  const phase = mapAcpUpdateToProgress({ sessionUpdate: "tool_call", title: "Read file" });
  assert.equal(phase.type, "phase");
  assert.match(phase.message, /Read file/);
  assert.equal(mapAcpUpdateToProgress({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }), null);
  assert.equal(mapAcpUpdateToProgress({ sessionUpdate: "agent_thought_chunk" }), null);
  assert.equal(mapAcpUpdateToProgress(null), null);
});

test("ACP path: onStream receives phase + message_chunk mapped from session/update", async () => {
  const events = [];
  const res = await runAcpOpencodeTurn(repoRoot, "hi", {
    role: "delegate",
    onStream: (e) => events.push(e),
    spawnSpec: fixtureSpawnSpec(["--stream", "one |two"])
  });
  assert.equal(res.error, null);
  const chunks = events.filter((e) => e.type === "message_chunk").map((e) => e.text);
  assert.deepEqual(chunks, ["one ", "two"]);
});

// ── cancel routing ────────────────────────────────────────────────────────────

test("cancelOpencode: headless transport (default) reports process-tree", async () => {
  await withTransport(undefined, async () => {
    const res = await cancelOpencode("job-oc-1");
    assert.equal(res.transport, "process-tree");
    assert.match(res.detail, /job-oc-1/);
  });
});

test("cancelOpencode: acp transport with no in-flight turn reports process-tree (cross-process backstop)", async () => {
  await withTransport("acp", async () => {
    const res = await cancelOpencode("job-oc-2");
    assert.equal(res.transport, "process-tree");
    assert.equal(res.interrupted, false);
    assert.match(res.detail, /job-oc-2/);
  });
});

test("ACP cancel routes to the in-flight turn handle, killing the child", async () => {
  // Start an ACP turn that ignores cancel → the in-protocol cancel + grace +
  // tree-kill path runs; cancelAcpOpencode(jobId) must reach the live handle.
  const jobId = "job-oc-inflight";
  const p = runAcpOpencodeTurn(repoRoot, "hi", {
    role: "delegate",
    jobId,
    spawnSpec: fixtureSpawnSpec(["--cancel-mode", "ignore", "--stream", ""])
  });
  // Let the handshake complete, then cancel via the adapter cancel (in-process).
  await new Promise((r) => setTimeout(r, 400));
  const cancelRes = await cancelAcpOpencode(jobId);
  assert.equal(cancelRes.transport, "acp");
  assert.equal(cancelRes.interrupted, true, "in-flight handle was found and cancelled");
  const res = await p;
  assert.equal(res.error?.message ? true : res.status === 0 || res.status === 1, true);
});

// ── contract shape still intact ───────────────────────────────────────────────

test("adapter still conforms (name opencode, invoke/cancel functions)", () => {
  assert.equal(adapter.name, "opencode");
  assert.equal(typeof adapter.invoke, "function");
  assert.equal(typeof adapter.cancel, "function");
  assert.equal(adapter.getSession, undefined);
});

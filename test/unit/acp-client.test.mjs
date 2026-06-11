// Offline, Windows-first contract tests for the ACP turn runner
// (lib/acp/client.mjs), its win32 spawn resolution (lib/acp/resolve.mjs), and the
// vendored SDK drift gate. No real CLI is spawned — a fake ACP agent fixture
// (test/fixtures/fake-acp-agent.mjs) speaks newline-delimited JSON-RPC over stdio
// and is driven by argv flags, so every scenario runs deterministically offline.

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  runAcpTurn,
  listModelValueIds,
  findModelConfigOption,
} from "../../plugins/multi/scripts/lib/acp/client.mjs";
import {
  resolveOpenCodeAcp,
  resolveCursorAcp,
  pickLatestCursorVersionDir,
} from "../../plugins/multi/scripts/lib/acp/resolve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const FIXTURE = path.join(repoRoot, "test", "fixtures", "fake-acp-agent.mjs");
const NODE = process.execPath;

// Spawn the fake agent with the given fixture flags. Diagnostics are swallowed by
// default; tests that care pass their own onDiagnostic.
function spawnSpec(flags, extra = {}) {
  return {
    exe: NODE,
    args: [FIXTURE, ...flags],
    cwd: repoRoot,
    prompt: "do the thing",
    onDiagnostic: () => {},
    ...extra,
  };
}

function tmpRecord() {
  return path.join(os.tmpdir(), `acp-rec-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
}
function readRecord(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Probe whether a PID is alive (signal 0 throws ESRCH when dead).
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

// ── 1. happy path: stream accumulation + onStream order + end_turn ─────────────

test("happy path: streamed chunks accumulate in order, stopReason end_turn", async () => {
  const chunks = [];
  const r = await runAcpTurn(
    spawnSpec(["--stream", "Hello |brave |world", "--stop", "end_turn"], {
      onStream: (t) => chunks.push(t),
    })
  );
  assert.equal(r.error, null);
  assert.equal(r.text, "Hello brave world");
  assert.deepEqual(chunks, ["Hello ", "brave ", "world"]);
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.cancelled, false);
  assert.ok(r.sessionId, "a sessionId is captured");
});

// ── 2. setSessionMode + set_config_option are sent when requested ─────────────

test("setSessionMode and set_config_option are sent with the {sessionId,configId,value} shape", async () => {
  const rec = tmpRecord();
  try {
    const r = await runAcpTurn(
      spawnSpec(["--models", "m1,m2,m3", "--modes", "ask,plan", "--record", rec], {
        sessionMode: "ask",
        model: "m2",
      })
    );
    assert.equal(r.error, null);
    assert.equal(r.stopReason, "end_turn");
    const lines = readRecord(rec);
    const setMode = lines.find((l) => "set_mode" in l);
    assert.ok(setMode, "session/set_mode was received");
    assert.equal(setMode.set_mode, "ask");
    const setConfig = lines.find((l) => "set_config" in l);
    assert.ok(setConfig, "session/set_config_option was received");
    assert.equal(setConfig.set_config.configId, "model");
    assert.equal(setConfig.set_config.value, "m2");
    assert.ok(setConfig.set_config.sessionId, "set_config carries the sessionId");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

// ── 3. model-not-in-options → turn fails BEFORE prompt with a config error ────

test("model not in the live options list → config error before any prompt", async () => {
  const rec = tmpRecord();
  try {
    const r = await runAcpTurn(
      spawnSpec(["--models", "m1,m2", "--record", rec], { model: "does-not-exist" })
    );
    assert.ok(r.error, "an error is set");
    assert.equal(r.error.code, "config");
    assert.match(r.error.message, /does-not-exist/);
    assert.match(r.error.detail, /m1, m2/);
    assert.equal(r.stopReason, null, "no turn completed");
    const lines = readRecord(rec);
    assert.ok(
      !lines.some((l) => l.recv === "session/prompt"),
      "session/prompt must NOT be sent when the model is invalid"
    );
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

// ── 4. permission auto-reject by default; allow when allowWrites ──────────────

test("permission requests are rejected by default", async () => {
  const rec = tmpRecord();
  try {
    await runAcpTurn(spawnSpec(["--permission", "--record", rec]));
    const lines = readRecord(rec);
    const outcome = lines.find((l) => "permission_outcome" in l)?.permission_outcome;
    assert.ok(outcome, "the agent recorded the permission decision");
    assert.equal(outcome.outcome, "selected");
    assert.equal(outcome.optionId, "reject-once");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

test("permission requests are allowed when allowWrites is set", async () => {
  const rec = tmpRecord();
  try {
    await runAcpTurn(spawnSpec(["--permission", "--record", rec], { allowWrites: true }));
    const lines = readRecord(rec);
    const outcome = lines.find((l) => "permission_outcome" in l)?.permission_outcome;
    assert.ok(outcome);
    assert.equal(outcome.outcome, "selected");
    assert.equal(outcome.optionId, "allow-once");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

// ── 5. cancel path A: agent honors cancel → cancelled + stopReason cancelled ──

test("cancel A (agent honors): stopReason cancelled, cancelled=true", async () => {
  const p = runAcpTurn(
    spawnSpec(["--cancel-mode", "honor", "--stream", "", "--delay-ms", "4000"], {
      inactivityMs: 60000,
    })
  );
  setTimeout(() => p.cancel(), 300);
  const r = await p;
  assert.equal(r.cancelled, true);
  assert.equal(r.stopReason, "cancelled");
  assert.equal(r.error, null);
});

// ── 6. cancel path B: agent mislabels end_turn → cancelled=true anyway ────────

test("cancel B (opencode mislabel): end_turn stopReason but cancelled=true", async () => {
  const p = runAcpTurn(
    spawnSpec(["--cancel-mode", "mislabel", "--stream", "", "--delay-ms", "4000"], {
      inactivityMs: 60000,
    })
  );
  setTimeout(() => p.cancel(), 300);
  const r = await p;
  assert.equal(r.cancelled, true, "cancel-requested + turn-ended ⇒ cancelled regardless of stopReason");
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.error, null);
});

// ── 7. cancel path C: agent ignores cancel → grace expires → tree-kill ────────

test("cancel C (agent ignores): grace expires, child tree-killed, no orphan, cancelled=true", async () => {
  const p = runAcpTurn(
    spawnSpec(["--cancel-mode", "ignore", "--stream", ""], { inactivityMs: 60000 })
  );
  // Give the handshake a moment, then cancel.
  await new Promise((r) => setTimeout(r, 400));
  const pid = p.pid;
  assert.ok(pid, "child pid is exposed");
  p.cancel();
  const r = await p;
  assert.equal(r.cancelled, true);
  // The child must be dead (tree-killed). Allow a brief settle for taskkill.
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(isAlive(pid), false, "no orphaned child process after tree-kill");
});

// ── 8. inactivity watchdog: agent goes silent → timeout error, child reaped ───

test("inactivity watchdog: silent agent → error code timeout, child reaped", async () => {
  const p = runAcpTurn(spawnSpec(["--silent-after-init"], { inactivityMs: 600 }));
  await new Promise((r) => setTimeout(r, 200));
  const pid = p.pid;
  const r = await p;
  assert.ok(r.error, "an error is set");
  assert.equal(r.error.code, "timeout");
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(isAlive(pid), false, "child reaped after inactivity timeout");
});

// ── 9. child exits before handshake → spawn error with stderr detail ──────────

test("child dies before handshake (--die-early) → error code spawn with stderr detail, exit 1", async () => {
  const r = await runAcpTurn(spawnSpec(["--die-early"]));
  assert.ok(r.error);
  assert.equal(r.error.code, "spawn");
  assert.match(r.error.detail ?? "", /die-early|fatal/i);
  assert.equal(r.exitCode, 1);
});

// ── 10. unknown sessionUpdate kinds → no crash; known thought kind passes ─────

test("unknown sessionUpdate kinds do not crash; agent_thought_chunk/usage reach onUpdate", async () => {
  // The SDK's zod union drops a made-up kind (logging to stderr) but must not
  // crash the connection. Silence that one expected console.error for clean test
  // output; assert the turn still completes and the known kinds pass through.
  const realErr = console.error;
  console.error = () => {};
  const updates = [];
  let r;
  try {
    r = await runAcpTurn(
      spawnSpec(["--thought", "--weird-update", "--stream", "answer", "--usage"], {
        onUpdate: (u) => updates.push(u.sessionUpdate),
      })
    );
  } finally {
    console.error = realErr;
  }
  assert.equal(r.error, null, "the made-up kind did not crash the turn");
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.text, "answer");
  assert.ok(updates.includes("agent_thought_chunk"), "agent_thought_chunk reaches onUpdate");
  assert.ok(updates.includes("usage_update"), "usage_update reaches onUpdate");
  assert.ok(r.usage && r.usage.used === 1234, "usage snapshot captured");
});

// ── 11. cwd with spaces works end-to-end ──────────────────────────────────────

test("cwd containing spaces works end-to-end", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "acp space "));
  const dir = path.join(base, "with space dir");
  fs.mkdirSync(dir, { recursive: true });
  try {
    const r = await runAcpTurn(
      spawnSpec(["--stream", "spaced ok"], { cwd: dir })
    );
    assert.equal(r.error, null);
    assert.equal(r.text, "spaced ok");
    assert.equal(r.stopReason, "end_turn");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── AbortSignal alternative to .cancel() ──────────────────────────────────────

test("spec.signal aborts the turn (cancelled=true)", async () => {
  const ac = new AbortController();
  const p = runAcpTurn(
    spawnSpec(["--cancel-mode", "honor", "--stream", "", "--delay-ms", "4000"], {
      inactivityMs: 60000,
      signal: ac.signal,
    })
  );
  setTimeout(() => ac.abort(), 300);
  const r = await p;
  assert.equal(r.cancelled, true);
});

// ── resolveModel callback (added for the cursor composite-id prefix resolution) ─

test("resolveModel callback: maps a requested name to a different live id, pinned via set_config", async () => {
  const rec = tmpRecord();
  try {
    const r = await runAcpTurn(
      spawnSpec(["--models", "alpha[fast=true],beta[x=1]", "--record", rec], {
        model: "alpha",
        // Resolve the friendly "alpha" to the live composite id.
        resolveModel: (ids, requested) => {
          const hit = ids.find((id) => id.split("[")[0] === requested);
          return hit ? { value: hit } : { error: { message: `no ${requested}` } };
        },
      })
    );
    assert.equal(r.error, null);
    assert.equal(r.stopReason, "end_turn");
    const setConfig = readRecord(rec).find((l) => "set_config" in l);
    assert.ok(setConfig, "set_config_option was sent");
    assert.equal(setConfig.set_config.value, "alpha[fast=true]", "the resolved composite id is pinned");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

test("resolveModel callback: an {error} return fails the turn BEFORE prompting", async () => {
  const rec = tmpRecord();
  try {
    const r = await runAcpTurn(
      spawnSpec(["--models", "alpha[fast=true]", "--record", rec], {
        model: "gamma",
        resolveModel: () => ({ error: { code: "config", message: "gamma is ambiguous", detail: "x, y" } }),
      })
    );
    assert.ok(r.error, "an error is set");
    assert.equal(r.error.code, "config");
    assert.match(r.error.message, /ambiguous/);
    assert.equal(r.stopReason, null, "no turn completed");
    const lines = readRecord(rec);
    assert.ok(!lines.some((l) => l.recv === "session/prompt"), "no prompt sent when the resolver errors");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

test("resolveModel callback: {value: undefined} leaves the model unpinned (no set_config)", async () => {
  const rec = tmpRecord();
  try {
    const r = await runAcpTurn(
      spawnSpec(["--models", "alpha[fast=true]", "--record", rec], {
        // No model + a resolver that declines to pin.
        resolveModel: () => ({ value: undefined }),
      })
    );
    assert.equal(r.error, null);
    assert.equal(r.stopReason, "end_turn");
    const lines = readRecord(rec);
    assert.ok(!lines.some((l) => "set_config" in l), "no set_config_option when nothing is pinned");
  } finally {
    fs.rmSync(rec, { force: true });
  }
});

// ── model-option helpers (pure) ───────────────────────────────────────────────

test("listModelValueIds flattens flat and grouped option lists", () => {
  const flat = { options: [{ value: "a" }, { value: "b" }] };
  assert.deepEqual(listModelValueIds(flat), ["a", "b"]);
  const grouped = {
    options: [
      { group: "g1", options: [{ value: "a" }, { value: "b" }] },
      { group: "g2", options: [{ value: "c" }] },
    ],
  };
  assert.deepEqual(listModelValueIds(grouped), ["a", "b", "c"]);
  assert.deepEqual(listModelValueIds(null), []);
  assert.deepEqual(listModelValueIds({}), []);
});

test("findModelConfigOption prefers category, falls back to id", () => {
  const byCategory = [{ id: "x", category: "model" }];
  assert.equal(findModelConfigOption(byCategory).id, "x");
  const byId = [{ id: "model", category: "other" }];
  assert.equal(findModelConfigOption(byId).id, "model");
  assert.equal(findModelConfigOption([{ id: "mode" }]), null);
  assert.equal(findModelConfigOption(null), null);
});

// ── resolve.mjs: OpenCode ─────────────────────────────────────────────────────

test("resolveOpenCodeAcp: env override wins and carries acp args", () => {
  const r = resolveOpenCodeAcp({
    env: { OPENCODE_CLI_PATH: "C:\\custom\\opencode.exe" },
    platform: "win32",
  });
  assert.equal(r.exe, "C:/custom/opencode.exe");
  assert.deepEqual(r.args, ["acp", "--print-logs", "--log-level", "INFO"]);
});

test("resolveOpenCodeAcp: non-win32 falls back to the bare binary name", () => {
  const r = resolveOpenCodeAcp({ env: {}, platform: "linux" });
  assert.equal(r.exe, "opencode");
  assert.deepEqual(r.args, ["acp", "--print-logs", "--log-level", "INFO"]);
});

test("resolveOpenCodeAcp: missing binary on win32 → {exe:null, detail} (no throw)", () => {
  const r = resolveOpenCodeAcp({
    env: {},
    platform: "win32",
    homedir: path.join(os.tmpdir(), "no-such-home-" + Math.random().toString(36).slice(2)),
  });
  assert.equal(r.exe, null);
  assert.match(r.detail, /not found|OPENCODE_CLI_PATH/i);
});

test("resolveOpenCodeAcp: discovers the platform exe under a fixture APPDATA", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-home-"));
  const binDir = path.join(
    home,
    "AppData",
    "Roaming",
    "npm",
    "node_modules",
    "opencode-ai",
    "node_modules",
    "opencode-windows-x64",
    "bin"
  );
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "opencode.exe"), "stub");
  try {
    const r = resolveOpenCodeAcp({ env: {}, platform: "win32", homedir: home });
    assert.ok(r.exe && r.exe.endsWith("opencode.exe"));
    assert.ok(r.exe.includes("/"), "path is normalized to forward slashes");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── resolve.mjs: Cursor version-dir selection ─────────────────────────────────

test("pickLatestCursorVersionDir picks the lexically-latest date dir, ignoring non-date dirs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-versions-"));
  try {
    for (const name of ["2026.05.01-aaa", "2026.06.04-bbb", "2026.04.17-ccc", "dist-package", "latest"]) {
      fs.mkdirSync(path.join(root, name));
    }
    assert.equal(pickLatestCursorVersionDir(root), "2026.06.04-bbb");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pickLatestCursorVersionDir returns null when no date dirs / missing dir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-empty-"));
  try {
    fs.mkdirSync(path.join(root, "dist-package"));
    assert.equal(pickLatestCursorVersionDir(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(pickLatestCursorVersionDir(path.join(os.tmpdir(), "nope-" + Math.random())), null);
});

test("resolveCursorAcp: env override wins and uses the bare acp arg", () => {
  const r = resolveCursorAcp({
    env: { CURSOR_AGENT_PATH: "C:\\custom\\cursor-agent.cmd" },
    platform: "win32",
  });
  assert.equal(r.exe, "C:/custom/cursor-agent.cmd");
  assert.deepEqual(r.args, ["acp"]);
});

test("resolveCursorAcp: non-win32 falls back to bare cursor-agent", () => {
  const r = resolveCursorAcp({ env: {}, platform: "linux" });
  assert.equal(r.exe, "cursor-agent");
  assert.deepEqual(r.args, ["acp"]);
});

test("resolveCursorAcp: win32 builds node.exe + index.js acp from the latest version dir", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-home-"));
  const verDir = path.join(home, "AppData", "Local", "cursor-agent", "versions", "2026.06.04-xyz");
  fs.mkdirSync(verDir, { recursive: true });
  fs.writeFileSync(path.join(verDir, "node.exe"), "stub");
  fs.writeFileSync(path.join(verDir, "index.js"), "stub");
  // An older incomplete dir should be ignored in favor of the latest complete one.
  const older = path.join(home, "AppData", "Local", "cursor-agent", "versions", "2026.05.01-old");
  fs.mkdirSync(older, { recursive: true });
  try {
    const r = resolveCursorAcp({ env: {}, platform: "win32", homedir: home });
    assert.ok(r.exe && r.exe.endsWith("node.exe"));
    assert.ok(r.exe.includes("2026.06.04-xyz"), "uses the latest version dir");
    assert.equal(r.args.length, 2);
    assert.ok(r.args[0].endsWith("index.js"));
    assert.equal(r.args[1], "acp");
    assert.ok(r.args[0].includes("/"), "index.js path normalized to forward slashes");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolveCursorAcp: incomplete latest version dir → {exe:null, detail}", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-incomplete-"));
  const verDir = path.join(home, "AppData", "Local", "cursor-agent", "versions", "2026.06.04-xyz");
  fs.mkdirSync(verDir, { recursive: true });
  // node.exe present but index.js missing.
  fs.writeFileSync(path.join(verDir, "node.exe"), "stub");
  try {
    const r = resolveCursorAcp({ env: {}, platform: "win32", homedir: home });
    assert.equal(r.exe, null);
    assert.match(r.detail, /incomplete|index\.js|CURSOR_AGENT_PATH/i);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolveCursorAcp: missing versions dir on win32 → {exe:null, detail} (no throw)", () => {
  const home = path.join(os.tmpdir(), "no-cursor-home-" + Math.random().toString(36).slice(2));
  const r = resolveCursorAcp({ env: {}, platform: "win32", homedir: home });
  assert.equal(r.exe, null);
  assert.match(r.detail, /not found|CURSOR_AGENT_PATH/i);
});

// ── drift gate: vendored SDK bundle ───────────────────────────────────────────

test("vendor bundle exists, imports, exports the expected symbols, and records the locked SDK version", async () => {
  const bundlePath = path.join(
    repoRoot,
    "plugins",
    "multi",
    "scripts",
    "lib",
    "acp",
    "vendor",
    "acp-sdk.bundle.mjs"
  );
  assert.ok(fs.existsSync(bundlePath), "the committed bundle must exist (run `npm run build:acp-vendor`)");

  const mod = await import(pathToFileURL(bundlePath).href);
  for (const sym of ["ndJsonStream", "ClientSideConnection", "PROTOCOL_VERSION"]) {
    assert.ok(sym in mod, `bundle must export ${sym}`);
  }
  assert.equal(typeof mod.ndJsonStream, "function");
  assert.equal(typeof mod.ClientSideConnection, "function");
  assert.equal(mod.PROTOCOL_VERSION, 1);

  // The banner records the SDK version that built the bundle; it MUST match the
  // version locked in package-lock.json (rebuild the bundle when the lock drifts).
  const head = fs.readFileSync(bundlePath, "utf8").slice(0, 600);
  const bannerMatch = head.match(/Bundled @agentclientprotocol\/sdk version:\s*([0-9][^\s]*)/);
  assert.ok(bannerMatch, "bundle banner must record the SDK version");
  const bundleVersion = bannerMatch[1];

  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  const lockedVersion = lock.packages?.["node_modules/@agentclientprotocol/sdk"]?.version;
  assert.ok(lockedVersion, "package-lock.json must pin @agentclientprotocol/sdk");
  assert.equal(
    bundleVersion,
    lockedVersion,
    `vendor bundle (sdk ${bundleVersion}) is stale vs package-lock.json (sdk ${lockedVersion}); run \`npm run build:acp-vendor\``
  );
});

// ── failure-mode hardening (stress-test regressions, 2026-06-11) ──────────────

test("hang-at-handshake: inactivity watchdog fires pre-prompt, not the overall cap", async () => {
  const t0 = Date.now();
  const p = runAcpTurn(spawnSpec(["--hang-handshake"], { inactivityMs: 600, overallMs: 60000 }));
  await new Promise((r) => setTimeout(r, 200));
  const pid = p.pid;
  const r = await p;
  const elapsed = Date.now() - t0;
  assert.ok(r.error, "an error is set");
  assert.equal(r.error.code, "timeout");
  assert.match(r.error.message, /session\/update/);
  assert.ok(
    elapsed < 30000,
    `caught by inactivity (~600ms + cancel grace), not the overall cap (elapsed ${elapsed}ms)`
  );
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(isAlive(pid), false, "child reaped after handshake hang");
});

test("die-mid-turn: explicit crash/protocol error, never a success-shaped result", async () => {
  const r = await runAcpTurn(spawnSpec(["--die-mid-turn"], { inactivityMs: 60000 }));
  assert.ok(r.error, "mid-turn crash must set an error (never a silent success)");
  assert.ok(
    ["crash", "protocol"].includes(r.error.code),
    `error code crash|protocol whichever side wins the race, got ${r.error.code}`
  );
  assert.equal(r.stopReason, null);
  assert.equal(r.cancelled, false);
  assert.match(r.text, /partial before crash/, "partial streamed text is preserved");
});

test("MULTI_ACP_INACTIVITY_MS env knob bounds a silent agent without an explicit inactivityMs", async () => {
  const spec = spawnSpec(["--silent-after-init"]);
  spec.env = { ...process.env, MULTI_ACP_INACTIVITY_MS: "700" };
  const t0 = Date.now();
  const r = await runAcpTurn(spec);
  assert.equal(r.error?.code, "timeout");
  assert.ok(Date.now() - t0 < 30000, "the 700ms knob (not the 120s default) bounded the wait");
});

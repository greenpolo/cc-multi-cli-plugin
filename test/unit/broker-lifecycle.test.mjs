// Unit tests for the broker teardown path (see ARCHITECTURE.md → "Broker
// lifecycle"). Offline: uses a temp dir and a fake killProcess — no real broker.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  shouldIdleShutdown,
  teardownBrokerSession,
} from "../../plugins/multi/scripts/lib/broker-lifecycle.mjs";

function makeSessionDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cxc-test-"));
}

test("teardownBrokerSession kills the process and removes pid/log files + empty session dir", () => {
  const sessionDir = makeSessionDir();
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, "999999");
  fs.writeFileSync(logFile, "log output");

  let killed = null;
  teardownBrokerSession({
    pidFile,
    logFile,
    sessionDir,
    pid: 999999,
    killProcess: (p) => {
      killed = p;
    },
  });

  assert.equal(killed, 999999, "killProcess must be called with the broker pid");
  assert.equal(fs.existsSync(pidFile), false, "pid file must be removed");
  assert.equal(fs.existsSync(logFile), false, "log file must be removed");
  assert.equal(fs.existsSync(sessionDir), false, "emptied session dir must be removed");
});

test("teardownBrokerSession is safe when pid/killProcess are absent", () => {
  const sessionDir = makeSessionDir();
  const pidFile = path.join(sessionDir, "broker.pid");
  fs.writeFileSync(pidFile, "1");

  assert.doesNotThrow(() =>
    teardownBrokerSession({ pidFile, sessionDir, pid: null, killProcess: null }),
  );
  assert.equal(fs.existsSync(pidFile), false, "pid file must still be removed");

  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// Idle self-shutdown policy — the backstop that reaps brokers spawned for cwds
// the SessionEnd hook never sees (transient/extra workspaces). Wired into
// app-server-broker.mjs's idle timer.
test("shouldIdleShutdown reaps an idle broker once the idle window elapses", () => {
  assert.equal(
    shouldIdleShutdown({ busy: false, lastActivityMs: 0, nowMs: 600000, idleMs: 600000 }),
    true,
  );
});

test("shouldIdleShutdown keeps a busy broker alive even past the idle window", () => {
  assert.equal(
    shouldIdleShutdown({ busy: true, lastActivityMs: 0, nowMs: 10_000_000, idleMs: 600000 }),
    false,
  );
});

test("shouldIdleShutdown keeps an idle broker alive before the window elapses", () => {
  assert.equal(
    shouldIdleShutdown({ busy: false, lastActivityMs: 0, nowMs: 1000, idleMs: 600000 }),
    false,
  );
});

test("shouldIdleShutdown treats idleMs <= 0 as disabled", () => {
  assert.equal(
    shouldIdleShutdown({ busy: false, lastActivityMs: 0, nowMs: 10_000_000, idleMs: 0 }),
    false,
  );
});

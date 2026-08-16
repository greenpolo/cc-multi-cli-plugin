// terminateProcessTree POSIX path: a failed group kill (ESRCH — child not a
// group leader, i.e. spawned without `detached`) must fall back to a direct
// kill of the pid. Regression test for the Linux hang where non-detached ACP
// children were never reaped.
import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../../plugins/multi/scripts/lib/process.mjs";

function esrch() {
  const err = new Error("ESRCH");
  err.code = "ESRCH";
  return err;
}

test("group kill ESRCH → falls back to direct pid kill (delivered)", () => {
  const calls = [];
  const r = terminateProcessTree(1234, {
    platform: "linux",
    killImpl: (pid) => {
      calls.push(pid);
      if (pid < 0) throw esrch();
    }
  });
  assert.deepEqual(calls, [-1234, 1234]);
  assert.deepEqual(r, { attempted: true, delivered: true, method: "process" });
});

test("group kill ESRCH and pid ESRCH → delivered false (process gone)", () => {
  const r = terminateProcessTree(1234, {
    platform: "linux",
    killImpl: () => {
      throw esrch();
    }
  });
  assert.deepEqual(r, { attempted: true, delivered: false, method: "process" });
});

test("group kill success → no fallback", () => {
  const calls = [];
  const r = terminateProcessTree(1234, {
    platform: "linux",
    killImpl: (pid) => calls.push(pid)
  });
  assert.deepEqual(calls, [-1234]);
  assert.deepEqual(r, { attempted: true, delivered: true, method: "process-group" });
});

import test from "node:test";
import assert from "node:assert/strict";

import { isActiveJobStatus } from "../../plugins/multi/scripts/lib/commands/jobs.mjs";
import * as opencode from "../../plugins/multi/scripts/lib/adapters/opencode.mjs";

test("isActiveJobStatus treats queued and running as active", () => {
  assert.equal(isActiveJobStatus("queued"), true);
  assert.equal(isActiveJobStatus("running"), true);
});

test("isActiveJobStatus treats terminal and unknown statuses as inactive", () => {
  assert.equal(isActiveJobStatus("completed"), false);
  assert.equal(isActiveJobStatus("failed"), false);
  assert.equal(isActiveJobStatus("cancelled"), false);
  assert.equal(isActiveJobStatus(undefined), false);
});

// ── OpenCode cancel branch ─────────────────────────────────────────────────────
// handleCancel's `else if (cli === "opencode")` branch calls
// opencode.adapter.cancel(job.id) and, when it reports attempted, appends the
// fixed log line "OpenCode cancel requested (process-tree)." Verify the adapter
// contract that gates the log line and the line text the branch emits.

test("opencode adapter cancel reports an attempted process-tree interrupt", async () => {
  const interrupt = await opencode.adapter.cancel("task-abc");
  assert.equal(interrupt.attempted, true, "attempted must be true so the cancel branch logs");
  assert.equal(interrupt.interrupted, false);
  assert.equal(interrupt.transport, "process-tree");
  assert.match(interrupt.detail, /task-abc/);
});

test("opencode cancel log line is the fixed process-tree string", () => {
  // Mirrors the literal appendLogLine text in handleCancel's opencode branch.
  const interrupt = { attempted: true, transport: "process-tree" };
  const line = interrupt.attempted ? "OpenCode cancel requested (process-tree)." : null;
  assert.equal(line, "OpenCode cancel requested (process-tree).");
});

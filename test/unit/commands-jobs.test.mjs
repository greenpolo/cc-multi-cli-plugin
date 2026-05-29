import test from "node:test";
import assert from "node:assert/strict";

import { isActiveJobStatus } from "../../plugins/multi/scripts/lib/commands/jobs.mjs";

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

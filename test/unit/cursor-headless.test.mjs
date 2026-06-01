// Pure-helper tests for the Cursor headless adapter (agent -p transport).
// The spawn itself is exercised by the live smoke; these cover the pure pieces:
// role→flag mapping, output parsing, error handling, and stream-json derivation.

import test from "node:test";
import assert from "node:assert/strict";

import {
  isReadOnlyRole,
  headlessOutputFormat,
  buildHeadlessArgs,
  streamToolKind,
  mapStreamEventToProgress,
  deriveFileChanges,
  deriveCommandExecutions,
  deriveToolCalls,
  parseJsonResult,
  normalizeHeadlessOutcome,
  adapter
} from "../../plugins/multi/scripts/lib/adapters/cursor.mjs";

// ── role classification ───────────────────────────────────────────────────────

test("isReadOnlyRole: research/explore/ask/planner are read-only; delegate/writer are not", () => {
  for (const r of ["research", "researcher", "explore", "explorer", "ask", "planner", "plan"]) {
    assert.equal(isReadOnlyRole(r), true, `${r} should be read-only`);
  }
  for (const r of ["delegate", "writer", "debugger", "execute"]) {
    assert.equal(isReadOnlyRole(r), false, `${r} should not be read-only`);
  }
  assert.equal(isReadOnlyRole("RESEARCH"), true); // case-insensitive
  assert.equal(isReadOnlyRole(undefined), false);
});

test("headlessOutputFormat: read-only → json, write → stream-json", () => {
  assert.equal(headlessOutputFormat("research"), "json");
  assert.equal(headlessOutputFormat("explore"), "json");
  assert.equal(headlessOutputFormat("delegate"), "stream-json");
});

// ── buildHeadlessArgs ─────────────────────────────────────────────────────────

test("buildHeadlessArgs: delegate uses agent mode (force+trust) and stream-json", () => {
  const args = buildHeadlessArgs({ role: "delegate", cwd: "/work" });
  assert.deepEqual(args, [
    "-p", "--output-format", "stream-json", "--stream-partial-output",
    "--model", "auto", "--force", "--trust", "--workspace", "/work"
  ]);
  assert.ok(!args.includes("--mode"), "delegate must not set --mode");
});

test("buildHeadlessArgs: research uses --mode ask + --force + json (no --trust)", () => {
  const args = buildHeadlessArgs({ role: "research", cwd: "/work" });
  assert.deepEqual(args, [
    "-p", "--output-format", "json", "--model", "auto", "--mode", "ask", "--force", "--workspace", "/work"
  ]);
  assert.ok(!args.includes("--trust"));
  assert.ok(!args.includes("--stream-partial-output"));
});

test("buildHeadlessArgs: explore mirrors research (read-only ask mode)", () => {
  const args = buildHeadlessArgs({ role: "explore", cwd: "/work" });
  assert.ok(args.includes("--mode") && args[args.indexOf("--mode") + 1] === "ask");
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
});

test("buildHeadlessArgs: model defaults to auto, override passes through", () => {
  assert.equal(buildHeadlessArgs({ role: "delegate" })[buildHeadlessArgs({ role: "delegate" }).indexOf("--model") + 1], "auto");
  const args = buildHeadlessArgs({ role: "delegate", model: "gpt-5.5-medium" });
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.5-medium");
  // blank/whitespace model falls back to auto
  const blank = buildHeadlessArgs({ role: "delegate", model: "  " });
  assert.equal(blank[blank.indexOf("--model") + 1], "auto");
});

test("buildHeadlessArgs: sessionId appends --resume <id>", () => {
  const args = buildHeadlessArgs({ role: "delegate", sessionId: "sess-123" });
  assert.equal(args[args.indexOf("--resume") + 1], "sess-123");
  assert.ok(!buildHeadlessArgs({ role: "delegate" }).includes("--resume"));
});

// ── stream event mapping ──────────────────────────────────────────────────────

test("streamToolKind strips the ToolCall suffix", () => {
  assert.equal(streamToolKind({ shellToolCall: {} }), "shell");
  assert.equal(streamToolKind({ readToolCall: {} }), "read");
  assert.equal(streamToolKind({ writeToolCall: {} }), "write");
  assert.equal(streamToolKind({}), "tool");
  assert.equal(streamToolKind(null), "tool");
});

test("mapStreamEventToProgress: tool_call started → phase; assistant → message_chunk; result → null", () => {
  const phase = mapStreamEventToProgress({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: {} } });
  assert.equal(phase.type, "phase");
  assert.match(phase.message, /shell/);

  const chunk = mapStreamEventToProgress({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
  assert.deepEqual(chunk, { type: "message_chunk", text: "hi" });

  assert.equal(mapStreamEventToProgress({ type: "result", subtype: "success" }), null);
  assert.equal(mapStreamEventToProgress({ type: "system", subtype: "init" }), null);
  assert.equal(mapStreamEventToProgress(null), null);
});

// ── file / command derivation ─────────────────────────────────────────────────

test("deriveFileChanges: write/patch/delete tool calls become file changes; reads excluded; deduped", () => {
  const events = [
    { type: "tool_call", subtype: "completed", tool_call: { writeToolCall: { args: { path: "a.js" } } } },
    { type: "tool_call", subtype: "completed", tool_call: { applyPatchToolCall: { result: { success: { path: "b.js" } } } } },
    { type: "tool_call", subtype: "completed", tool_call: { deleteToolCall: { args: { path: "c.js" } } } },
    { type: "tool_call", subtype: "completed", tool_call: { readToolCall: { args: { path: "ignored.js" } } } },
    { type: "tool_call", subtype: "completed", tool_call: { writeToolCall: { args: { path: "a.js" } } } } // dup
  ];
  assert.deepEqual(deriveFileChanges(events), [
    { path: "a.js", action: "modify" },
    { path: "b.js", action: "modify" },
    { path: "c.js", action: "delete" }
  ]);
  assert.deepEqual(deriveFileChanges([]), []);
  assert.deepEqual(deriveFileChanges(undefined), []);
});

test("deriveFileChanges: search_replace edits are captured (regression — not vetoed by 'search')", () => {
  const events = [
    { type: "tool_call", subtype: "completed", tool_call: { searchReplaceToolCall: { args: { path: "edited.js" } } } },
    { type: "tool_call", subtype: "completed", tool_call: { webSearchToolCall: { args: { query: "node version" } } } },
    { type: "tool_call", subtype: "completed", tool_call: { codebaseSearchToolCall: { args: { query: "foo" } } } }
  ];
  // searchReplace targets a path and carries an edit verb → captured; the two
  // search tools have no edit verb (and no path) → excluded.
  assert.deepEqual(deriveFileChanges(events), [{ path: "edited.js", action: "modify" }]);
});

test("deriveCommandExecutions: only completed shell tool calls", () => {
  const events = [
    { type: "tool_call", subtype: "completed", tool_call: { shellToolCall: { args: { command: "npm test" } } } },
    { type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "ignored (started)" } } } },
    { type: "tool_call", subtype: "completed", tool_call: { readToolCall: { args: { path: "x" } } } }
  ];
  assert.deepEqual(deriveCommandExecutions(events), [{ command: "npm test" }]);
});

test("deriveToolCalls: lists completed tool kinds", () => {
  const events = [
    { type: "tool_call", subtype: "completed", tool_call: { shellToolCall: {} } },
    { type: "tool_call", subtype: "completed", tool_call: { readToolCall: {} } }
  ];
  assert.deepEqual(deriveToolCalls(events), [{ name: "shell" }, { name: "read" }]);
});

// ── parseJsonResult ───────────────────────────────────────────────────────────

test("parseJsonResult: parses a single object, tolerates trailing newline, scans lines, rejects junk", () => {
  const obj = parseJsonResult('{"type":"result","result":"ok"}\n');
  assert.equal(obj.result, "ok");

  const scanned = parseJsonResult('some preamble\n{"type":"result","result":"x","session_id":"s"}\n');
  assert.equal(scanned?.session_id, "s");

  assert.equal(parseJsonResult(""), null);
  assert.equal(parseJsonResult("not json at all"), null);
});

// ── normalizeHeadlessOutcome ──────────────────────────────────────────────────

test("normalizeHeadlessOutcome: json success maps result/session_id, status 0, no error", () => {
  const stdoutText = '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"s1"}';
  const out = normalizeHeadlessOutcome({ stdoutText, exitCode: 0, outputFormat: "json" });
  assert.equal(out.text, "hello");
  assert.equal(out.sessionId, "s1");
  assert.equal(out.status, 0);
  assert.equal(out.error, null);
});

test("normalizeHeadlessOutcome: is_error:true yields an error and status 1", () => {
  const stdoutText = '{"type":"result","subtype":"error","is_error":true,"result":"boom","session_id":"s2"}';
  const out = normalizeHeadlessOutcome({ stdoutText, exitCode: 0, outputFormat: "json" });
  assert.equal(out.status, 1);
  assert.equal(out.error.message, "boom");
});

test("normalizeHeadlessOutcome: startup failure (exit 1, stderr, no json) surfaces stderr as error", () => {
  const out = normalizeHeadlessOutcome({
    stdoutText: "",
    stderr: "Cannot use this model: bogus. Available models: auto, ...",
    exitCode: 1,
    outputFormat: "json"
  });
  assert.equal(out.status, 1);
  assert.match(out.error.message, /Cannot use this model/);
  assert.equal(out.text, "");
});

test("normalizeHeadlessOutcome: stream-json picks the final result event and derives activity", () => {
  const events = [
    { type: "system", subtype: "init", session_id: "s3", model: "Auto" },
    { type: "tool_call", subtype: "completed", tool_call: { writeToolCall: { args: { path: "x.js" } } } },
    { type: "tool_call", subtype: "completed", tool_call: { shellToolCall: { args: { command: "echo hi" } } } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s3" }
  ];
  const out = normalizeHeadlessOutcome({ events, exitCode: 0, outputFormat: "stream-json" });
  assert.equal(out.text, "done");
  assert.equal(out.sessionId, "s3");
  assert.equal(out.status, 0);
  assert.deepEqual(out.fileChanges, [{ path: "x.js", action: "modify" }]);
  assert.deepEqual(out.commandExecutions, [{ command: "echo hi" }]);
});

test("normalizeHeadlessOutcome: exit 0 but no result is treated as an error", () => {
  const out = normalizeHeadlessOutcome({ stdoutText: "", stderr: "", exitCode: 0, outputFormat: "json" });
  assert.equal(out.status, 1);
  assert.ok(out.error);
});

// ── adapter contract shape ────────────────────────────────────────────────────

test("adapter exports the required contract members with name 'cursor'", () => {
  assert.equal(adapter.name, "cursor");
  for (const fn of ["isAvailable", "isAuthenticated", "invoke", "cancel"]) {
    assert.equal(typeof adapter[fn], "function", `adapter.${fn} must be a function`);
  }
  assert.equal(adapter.getSession, undefined);
});

test("adapter.cancel reports the process-tree mechanism", async () => {
  const res = await adapter.cancel("job-123");
  assert.equal(res.attempted, true);
  assert.equal(res.transport, "process-tree");
  assert.match(res.detail, /job-123/);
});

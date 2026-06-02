// Pure-helper tests for the OpenCode headless adapter (opencode run --format json).
// The spawn itself is exercised by a later live smoke; these cover the pure pieces:
// role→flag/agent mapping, NDJSON parsing, error handling, and outcome normalization.

import test from "node:test";
import assert from "node:assert/strict";

import {
  isReadOnlyRole,
  headlessOutputFormat,
  resolveModel,
  readOnlyAgentName,
  buildHeadlessArgs,
  buildReadOnlyConfigContent,
  buildOpencodeSpawnEnv,
  READ_ONLY_PERMISSION_FLOOR,
  streamToolKind,
  mapEventToProgress,
  deriveFileChanges,
  deriveCommandExecutions,
  deriveToolCalls,
  firstSessionId,
  normalizeHeadlessOutcome,
  adapter
} from "../../plugins/multi/scripts/lib/adapters/opencode.mjs";

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

test("headlessOutputFormat: json for every role (opencode has only default|json)", () => {
  assert.equal(headlessOutputFormat("research"), "json");
  assert.equal(headlessOutputFormat("explore"), "json");
  assert.equal(headlessOutputFormat("delegate"), "json");
});

test("readOnlyAgentName: research family → oc-research, everything else → oc-explore", () => {
  assert.equal(readOnlyAgentName("research"), "oc-research");
  assert.equal(readOnlyAgentName("researcher"), "oc-research");
  assert.equal(readOnlyAgentName("explore"), "oc-explore");
  assert.equal(readOnlyAgentName("ask"), "oc-explore");
  assert.equal(readOnlyAgentName("plan"), "oc-explore");
});

// ── resolveModel ──────────────────────────────────────────────────────────────

test("resolveModel: override wins, blank/absent → default opencode/claude-opus-4-8", () => {
  assert.equal(resolveModel("openai/gpt-5"), "openai/gpt-5");
  assert.equal(resolveModel("  google/gemini-3  "), "google/gemini-3");
  assert.equal(resolveModel(""), "opencode/claude-opus-4-8");
  assert.equal(resolveModel("   "), "opencode/claude-opus-4-8");
  assert.equal(resolveModel(undefined), "opencode/claude-opus-4-8");
});

test("resolveModel: OPENCODE_CLI_DEFAULT_MODEL is used when no explicit model", () => {
  const prev = process.env.OPENCODE_CLI_DEFAULT_MODEL;
  try {
    process.env.OPENCODE_CLI_DEFAULT_MODEL = "openai/gpt-5-mini";
    assert.equal(resolveModel(undefined), "openai/gpt-5-mini");
    assert.equal(resolveModel(""), "openai/gpt-5-mini");
    // explicit override still wins over the env default
    assert.equal(resolveModel("ollama/llama3"), "ollama/llama3");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_CLI_DEFAULT_MODEL;
    else process.env.OPENCODE_CLI_DEFAULT_MODEL = prev;
  }
});

// ── buildHeadlessArgs ─────────────────────────────────────────────────────────

test("buildHeadlessArgs: delegate uses --dangerously-skip-permissions, no --agent, json", () => {
  const args = buildHeadlessArgs({ role: "delegate" });
  assert.deepEqual(args, [
    "run", "--format", "json", "--model", "opencode/claude-opus-4-8", "--dangerously-skip-permissions"
  ]);
  assert.ok(!args.includes("--agent"), "delegate must not set --agent");
});

test("buildHeadlessArgs: prompt is NEVER in argv (delivered on stdin)", () => {
  const args = buildHeadlessArgs({ role: "delegate", model: "openai/gpt-5" });
  // No element should look like a prompt; only the known flags + values are present.
  assert.deepEqual(args, [
    "run", "--format", "json", "--model", "openai/gpt-5", "--dangerously-skip-permissions"
  ]);
});

test("buildHeadlessArgs: research → --agent oc-research, no skip-perms", () => {
  const args = buildHeadlessArgs({ role: "research" });
  assert.equal(args[args.indexOf("--agent") + 1], "oc-research");
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.equal(args[args.indexOf("--format") + 1], "json");
});

test("buildHeadlessArgs: explore → --agent oc-explore, no skip-perms", () => {
  const args = buildHeadlessArgs({ role: "explore" });
  assert.equal(args[args.indexOf("--agent") + 1], "oc-explore");
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

test("buildHeadlessArgs: model default + override + blank → default", () => {
  assert.equal(
    buildHeadlessArgs({ role: "delegate" })[buildHeadlessArgs({ role: "delegate" }).indexOf("--model") + 1],
    "opencode/claude-opus-4-8"
  );
  const overridden = buildHeadlessArgs({ role: "delegate", model: "openai/gpt-5" });
  assert.equal(overridden[overridden.indexOf("--model") + 1], "openai/gpt-5");
  const blank = buildHeadlessArgs({ role: "delegate", model: "  " });
  assert.equal(blank[blank.indexOf("--model") + 1], "opencode/claude-opus-4-8");
});

test("buildHeadlessArgs: sessionId appends --session <id> (never --continue); absent when none", () => {
  const args = buildHeadlessArgs({ role: "delegate", sessionId: "ses_abc" });
  assert.equal(args[args.indexOf("--session") + 1], "ses_abc");
  assert.ok(!args.includes("--continue"), "must never use --continue");
  assert.ok(!buildHeadlessArgs({ role: "delegate" }).includes("--session"));
});

test("buildHeadlessArgs: cwd appends --dir <cwd> (cursor --workspace analog); absent/blank → no --dir", () => {
  const args = buildHeadlessArgs({ role: "delegate", cwd: "C:/work/proj" });
  assert.equal(args[args.indexOf("--dir") + 1], "C:/work/proj");
  assert.ok(!buildHeadlessArgs({ role: "delegate" }).includes("--dir"), "no --dir when cwd omitted");
  assert.ok(!buildHeadlessArgs({ role: "delegate", cwd: "   " }).includes("--dir"), "no --dir for blank cwd");
});

// ── read-only spawn-env floor ───────────────────────────────────────────────

test("buildReadOnlyConfigContent: oc-explore denies edit/bash/write and disables web", () => {
  const cfg = JSON.parse(buildReadOnlyConfigContent("explore"));
  const agent = cfg.agent["oc-explore"];
  assert.equal(agent.mode, "primary");
  assert.equal(agent.permission.edit, "deny");
  assert.equal(agent.permission.bash, "deny");
  assert.equal(agent.permission.write, "deny");
  assert.equal(agent.permission.read, "allow");
  assert.equal(agent.permission.external_directory, "allow");
  assert.equal(agent.permission.webfetch, "deny");
  assert.equal(agent.permission.websearch, "deny");
});

test("buildReadOnlyConfigContent: oc-research allows web but still denies writes", () => {
  const cfg = JSON.parse(buildReadOnlyConfigContent("research"));
  const agent = cfg.agent["oc-research"];
  assert.equal(agent.permission.edit, "deny");
  assert.equal(agent.permission.bash, "deny");
  assert.equal(agent.permission.write, "deny");
  assert.equal(agent.permission.webfetch, "allow");
  assert.equal(agent.permission.websearch, "allow");
});

test("buildOpencodeSpawnEnv: clears server creds for all roles; injects config+floor for read-only", () => {
  const base = {
    OPENCODE_SERVER_PASSWORD: "secret",
    OPENCODE_SERVER_USERNAME: "admin",
    PATH: process.env.PATH
  };
  const ro = buildOpencodeSpawnEnv(base, "explore");
  assert.equal(ro.OPENCODE_SERVER_PASSWORD, undefined);
  assert.equal(ro.OPENCODE_SERVER_USERNAME, undefined);
  assert.ok(ro.OPENCODE_CONFIG_CONTENT, "read-only must inject OPENCODE_CONFIG_CONTENT");
  assert.equal(ro.OPENCODE_PERMISSION, READ_ONLY_PERMISSION_FLOOR);
  const floor = JSON.parse(ro.OPENCODE_PERMISSION);
  assert.equal(floor.edit, "deny");
  assert.equal(floor.bash, "deny");
  assert.equal(floor.write, "deny");

  const write = buildOpencodeSpawnEnv(base, "delegate");
  assert.equal(write.OPENCODE_SERVER_PASSWORD, undefined);
  assert.equal(write.OPENCODE_CONFIG_CONTENT, undefined, "write role must not inject the read-only config");
  assert.equal(write.OPENCODE_PERMISSION, undefined);
});

// ── stream event mapping ──────────────────────────────────────────────────────

test("streamToolKind reads part.tool, defaults to 'tool'", () => {
  assert.equal(streamToolKind({ part: { tool: "bash" } }), "bash");
  assert.equal(streamToolKind({ part: { tool: "write" } }), "write");
  assert.equal(streamToolKind({ part: {} }), "tool");
  assert.equal(streamToolKind(null), "tool");
});

test("mapEventToProgress: tool_use/step_start → phase; text → message_chunk; else null", () => {
  const phase = mapEventToProgress({ type: "tool_use", part: { tool: "bash", state: { status: "completed" } } });
  assert.equal(phase.type, "phase");
  assert.match(phase.message, /bash/);

  const stepPhase = mapEventToProgress({ type: "step_start", part: {} });
  assert.equal(stepPhase.type, "phase");

  const chunk = mapEventToProgress({ type: "text", part: { text: "hi" } });
  assert.deepEqual(chunk, { type: "message_chunk", text: "hi" });

  assert.equal(mapEventToProgress({ type: "step_finish", part: { reason: "stop" } }), null);
  assert.equal(mapEventToProgress({ type: "error", error: {} }), null);
  assert.equal(mapEventToProgress({ type: "reasoning", part: { text: "thinking" } }), null);
  assert.equal(mapEventToProgress({ type: "text", part: { text: "" } }), null);
  assert.equal(mapEventToProgress(null), null);
});

// ── file / command derivation ─────────────────────────────────────────────────

test("deriveFileChanges: completed write/edit/delete tool_use w/ input.filePath → change; reads excluded; deduped", () => {
  const events = [
    { type: "tool_use", part: { tool: "write", state: { status: "completed", input: { filePath: "a.js" } } } },
    { type: "tool_use", part: { tool: "edit", state: { status: "completed", input: { filePath: "b.js" } } } },
    { type: "tool_use", part: { tool: "delete", state: { status: "completed", input: { filePath: "c.js" } } } },
    { type: "tool_use", part: { tool: "read", state: { status: "completed", input: { filePath: "ignored.js" } } } },
    { type: "tool_use", part: { tool: "write", state: { status: "completed", input: { filePath: "a.js" } } } } // dup
  ];
  assert.deepEqual(deriveFileChanges(events), [
    { path: "a.js", action: "modify" },
    { path: "b.js", action: "modify" },
    { path: "c.js", action: "delete" }
  ]);
  assert.deepEqual(deriveFileChanges([]), []);
  assert.deepEqual(deriveFileChanges(undefined), []);
});

test("deriveFileChanges: only completed status counts; pending/error excluded", () => {
  const events = [
    { type: "tool_use", part: { tool: "write", state: { status: "pending", input: { filePath: "p.js" } } } },
    { type: "tool_use", part: { tool: "write", state: { status: "error", input: { filePath: "e.js" } } } },
    { type: "tool_use", part: { tool: "write", state: { status: "completed", input: { filePath: "ok.js" } } } }
  ];
  assert.deepEqual(deriveFileChanges(events), [{ path: "ok.js", action: "modify" }]);
});

test("deriveFileChanges: search_replace-style edits are captured (not vetoed by 'search'); web search excluded", () => {
  const events = [
    { type: "tool_use", part: { tool: "search_replace", state: { status: "completed", input: { filePath: "edited.js" } } } },
    { type: "tool_use", part: { tool: "websearch", state: { status: "completed", input: { query: "node version" } } } },
    { type: "tool_use", part: { tool: "grep", state: { status: "completed", input: { pattern: "foo" } } } }
  ];
  // search_replace carries an edit verb AND a filePath → captured; websearch/grep
  // have no edit verb (and no filePath) → excluded.
  assert.deepEqual(deriveFileChanges(events), [{ path: "edited.js", action: "modify" }]);
});

test("deriveCommandExecutions: only completed bash tool_use", () => {
  const events = [
    { type: "tool_use", part: { tool: "bash", state: { status: "completed", input: { command: "npm test" } } } },
    { type: "tool_use", part: { tool: "bash", state: { status: "pending", input: { command: "ignored (pending)" } } } },
    { type: "tool_use", part: { tool: "read", state: { status: "completed", input: { filePath: "x" } } } }
  ];
  assert.deepEqual(deriveCommandExecutions(events), [{ command: "npm test" }]);
  assert.deepEqual(deriveCommandExecutions([]), []);
});

test("deriveToolCalls: lists completed tool_use kinds", () => {
  const events = [
    { type: "tool_use", part: { tool: "bash", state: { status: "completed" } } },
    { type: "tool_use", part: { tool: "read", state: { status: "completed" } } },
    { type: "tool_use", part: { tool: "edit", state: { status: "pending" } } } // not completed
  ];
  assert.deepEqual(deriveToolCalls(events), [{ name: "bash" }, { name: "read" }]);
});

test("firstSessionId: returns the first sessionID seen", () => {
  assert.equal(firstSessionId([{ type: "step_start", sessionID: "ses_1" }, { type: "text", sessionID: "ses_1" }]), "ses_1");
  assert.equal(firstSessionId([{ type: "step_start" }, { type: "text", sessionID: "ses_2" }]), "ses_2");
  assert.equal(firstSessionId([]), null);
});

// ── normalizeHeadlessOutcome ──────────────────────────────────────────────────

test("normalizeHeadlessOutcome: concats text parts, sessionId from first sessionID, step_finish:stop → status 0", () => {
  const events = [
    { type: "step_start", sessionID: "ses_x" },
    { type: "tool_use", sessionID: "ses_x", part: { tool: "write", state: { status: "completed", input: { filePath: "x.js" } } } },
    { type: "tool_use", sessionID: "ses_x", part: { tool: "bash", state: { status: "completed", input: { command: "echo hi" } } } },
    { type: "text", sessionID: "ses_x", part: { text: "Hello " } },
    { type: "text", sessionID: "ses_x", part: { text: "world" } },
    { type: "step_finish", sessionID: "ses_x", part: { reason: "stop" } }
  ];
  const out = normalizeHeadlessOutcome({ events, exitCode: 0, role: "delegate" });
  assert.equal(out.text, "Hello world");
  assert.equal(out.sessionId, "ses_x");
  assert.equal(out.status, 0);
  assert.equal(out.error, null);
  assert.deepEqual(out.fileChanges, [{ path: "x.js", action: "modify" }]);
  assert.deepEqual(out.commandExecutions, [{ command: "echo hi" }]);
});

test("normalizeHeadlessOutcome: step_finish:stop with no text still succeeds (status 0)", () => {
  const events = [
    { type: "step_start", sessionID: "ses_s" },
    { type: "step_finish", sessionID: "ses_s", part: { reason: "stop" } }
  ];
  const out = normalizeHeadlessOutcome({ events, exitCode: 0, role: "delegate" });
  assert.equal(out.status, 0);
  assert.equal(out.error, null);
});

test("normalizeHeadlessOutcome: {type:error} event (e.g. bad --model) → status 1 + error from error.data.message", () => {
  const events = [
    { type: "step_start", sessionID: "ses_e" },
    { type: "error", sessionID: "ses_e", error: { data: { message: "Model not found" } } }
  ];
  const out = normalizeHeadlessOutcome({ events, exitCode: 1, role: "delegate" });
  assert.equal(out.status, 1);
  assert.match(out.error.message, /Model not found/);
});

test("normalizeHeadlessOutcome: exit 1 + ZERO events (bad --session, stderr only) → error from stderr", () => {
  const out = normalizeHeadlessOutcome({
    events: [],
    stderr: "Error: Session not found",
    exitCode: 1,
    role: "delegate"
  });
  assert.equal(out.status, 1);
  assert.match(out.error.message, /Session not found/);
  assert.equal(out.text, "");
  assert.equal(out.sessionId, null);
});

test("normalizeHeadlessOutcome: read-only 'Falling back to default agent' stderr → fail the turn", () => {
  const events = [
    { type: "step_start", sessionID: "ses_f" },
    { type: "text", sessionID: "ses_f", part: { text: "I will edit the file." } },
    { type: "step_finish", sessionID: "ses_f", part: { reason: "stop" } }
  ];
  const out = normalizeHeadlessOutcome({
    events,
    stderr: 'agent "oc-explore" not found. Falling back to default agent',
    exitCode: 0,
    role: "explore"
  });
  assert.notEqual(out.status, 0);
  assert.equal(out.error !== null, true);
  assert.match(out.error.message, /fell back to the default/i);
  assert.equal(out.text, "");
});

test("normalizeHeadlessOutcome: the same fallback line is harmless for a WRITE role", () => {
  const events = [
    { type: "text", sessionID: "ses_w", part: { text: "done" } },
    { type: "step_finish", sessionID: "ses_w", part: { reason: "stop" } }
  ];
  const out = normalizeHeadlessOutcome({
    events,
    stderr: "Falling back to default agent",
    exitCode: 0,
    role: "delegate"
  });
  assert.equal(out.status, 0);
  assert.equal(out.error, null);
  assert.equal(out.text, "done");
});

test("normalizeHeadlessOutcome: exit 0 but no text and no stop → treated as error", () => {
  const out = normalizeHeadlessOutcome({ events: [{ type: "step_start", sessionID: "s" }], exitCode: 0, role: "delegate" });
  assert.equal(out.status, 1);
  assert.ok(out.error);
});

test("normalizeHeadlessOutcome: stderr-only small_model noise tolerated when a text/stop turn exists", () => {
  const events = [
    { type: "text", sessionID: "ses_n", part: { text: "answer" } },
    { type: "step_finish", sessionID: "ses_n", part: { reason: "stop" } }
  ];
  const out = normalizeHeadlessOutcome({
    events,
    stderr: "small_model: Missing API key for anthropic",
    exitCode: 0,
    role: "research"
  });
  assert.equal(out.status, 0);
  assert.equal(out.error, null);
  assert.equal(out.text, "answer");
});

// ── adapter contract shape ────────────────────────────────────────────────────

test("adapter exports the required contract members with name 'opencode'", () => {
  assert.equal(adapter.name, "opencode");
  for (const fn of ["isAvailable", "isAuthenticated", "invoke", "cancel"]) {
    assert.equal(typeof adapter[fn], "function", `adapter.${fn} must be a function`);
  }
  assert.equal(adapter.getSession, undefined);
});

test("adapter.cancel reports the process-tree mechanism and includes the jobId", async () => {
  const res = await adapter.cancel("job-789");
  assert.equal(res.attempted, true);
  assert.equal(res.interrupted, false);
  assert.equal(res.transport, "process-tree");
  assert.match(res.detail, /job-789/);
});

// Pure-helper tests for the Antigravity adapter (agy -p + transcript-read).
// The spawn itself is exercised by the live smoke; these cover the pure pieces:
// role→flag mapping, log parsing (conv-id/app-dir), transcript parsing, answer
// + activity derivation, and outcome normalization — against real captured
// fixtures from the live probes (test/fixtures/antigravity/).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  isReadOnlyRole,
  buildHeadlessArgs,
  parseConversationId,
  parseAppDataDir,
  defaultAppDataDir,
  transcriptPath,
  parseTranscript,
  deriveFinalMessage,
  deriveToolCalls,
  deriveFileChanges,
  deriveCommandExecutions,
  normalizeAgyOutcome,
  adapter
} from "../../plugins/multi/scripts/lib/adapters/antigravity.mjs";

const fixture = (name) => fs.readFileSync(new URL(`../fixtures/antigravity/${name}`, import.meta.url), "utf8");
const EXPLORE = fixture("explore-transcript.jsonl");
const RESEARCH = fixture("research-transcript.jsonl");
const LOG = fixture("sample-print.log");

// ── role classification ─────────────────────────────────────────────────────

test("isReadOnlyRole: research/explore/ask/planner are read-only; delegate/writer are not", () => {
  for (const r of ["research", "researcher", "explore", "explorer", "ask", "planner", "plan"]) {
    assert.equal(isReadOnlyRole(r), true, `${r} should be read-only`);
  }
  for (const r of ["delegate", "writer", "execute"]) {
    assert.equal(isReadOnlyRole(r), false, `${r} should not be read-only`);
  }
  assert.equal(isReadOnlyRole("RESEARCH"), true); // case-insensitive
  assert.equal(isReadOnlyRole(undefined), false);
});

// ── buildHeadlessArgs ───────────────────────────────────────────────────────

test("buildHeadlessArgs: read-only role has prompt inline, no skip-permissions", () => {
  const args = buildHeadlessArgs({ prompt: "hi", cwd: "/work", logFile: "/tmp/x.log", printTimeout: "120s", role: "research" });
  assert.deepEqual(args, [
    "-p", "hi", "--add-dir", "/work", "--log-file", "/tmp/x.log", "--print-timeout", "120s"
  ]);
  assert.ok(!args.includes("--dangerously-skip-permissions"), "read-only must not skip permissions");
});

test("buildHeadlessArgs: prompt is the -p value (argv element, not stdin)", () => {
  const args = buildHeadlessArgs({ prompt: "multi\nline prompt", role: "explore" });
  assert.equal(args[0], "-p");
  assert.equal(args[1], "multi\nline prompt");
});

test("buildHeadlessArgs: a write role (future) adds --dangerously-skip-permissions", () => {
  const args = buildHeadlessArgs({ prompt: "go", cwd: "/work", role: "delegate" });
  assert.ok(args.includes("--dangerously-skip-permissions"));
});

// ── log parsing ─────────────────────────────────────────────────────────────

test("parseConversationId: reads 'Created conversation <id>', falls back to conversation=, else null", () => {
  assert.equal(parseConversationId(LOG), "1b6eab11-dffb-48c6-bc75-cf29b8f5d8f7");
  assert.equal(parseConversationId("...Print mode: conversation=abc-123, sending"), "abc-123");
  assert.equal(parseConversationId("no id here"), null);
  assert.equal(parseConversationId(undefined), null);
});

test("parseAppDataDir: reads the CLI app data directory line, else null", () => {
  assert.equal(parseAppDataDir(LOG), "C:\\Users\\dev\\.gemini\\antigravity-cli");
  assert.equal(parseAppDataDir("nothing relevant"), null);
});

test("defaultAppDataDir + transcriptPath compose the brain transcript path", () => {
  const p = transcriptPath("/root/.gemini/antigravity-cli", "ID");
  assert.match(p.replace(/\\/g, "/"), /\.gemini\/antigravity-cli\/brain\/ID\/\.system_generated\/logs\/transcript\.jsonl$/);
  assert.match(defaultAppDataDir().replace(/\\/g, "/"), /\.gemini\/antigravity-cli$/);
});

// ── transcript parsing + derivation ─────────────────────────────────────────

test("parseTranscript: one object per JSONL line; junk lines skipped", () => {
  assert.equal(parseTranscript(EXPLORE).length, 10);
  assert.equal(parseTranscript(RESEARCH).length, 8);
  assert.deepEqual(parseTranscript("not json\n{\"step_index\":0}\n"), [{ step_index: 0 }]);
  assert.deepEqual(parseTranscript(""), []);
});

test("deriveFinalMessage: returns the LAST non-empty MODEL/PLANNER_RESPONSE", () => {
  const explore = deriveFinalMessage(parseTranscript(EXPLORE));
  assert.match(explore, /^Here are the `?\.mjs/);
  assert.match(explore, /registry\.mjs/);

  const research = deriveFinalMessage(parseTranscript(RESEARCH));
  assert.match(research, /Node\.js 24/);
  assert.match(research, /nodejs\.org/);

  assert.equal(deriveFinalMessage([]), "");
});

test("deriveToolCalls: typed MODEL steps (not PLANNER_RESPONSE) become tool calls", () => {
  const explore = deriveToolCalls(parseTranscript(EXPLORE)).map((t) => t.name);
  assert.ok(explore.includes("LIST_DIRECTORY"));
  assert.ok(explore.includes("VIEW_FILE"));
  assert.ok(!explore.includes("PLANNER_RESPONSE"));

  const research = deriveToolCalls(parseTranscript(RESEARCH)).map((t) => t.name);
  assert.ok(research.includes("SEARCH_WEB"));
});

test("deriveFileChanges/deriveCommandExecutions: empty for read-only runs", () => {
  assert.deepEqual(deriveFileChanges(parseTranscript(EXPLORE)), []);
  assert.deepEqual(deriveFileChanges(parseTranscript(RESEARCH)), []);
  assert.deepEqual(deriveCommandExecutions(parseTranscript(EXPLORE)), []);
});

test("deriveFileChanges: edit-typed steps map to {path, action} (future write role)", () => {
  const steps = [
    { source: "MODEL", type: "EDIT_FILE", content: "File Path: `file:///C:/x/y.js`" },
    { source: "MODEL", type: "CREATE_FILE", content: "File Path: `file:///C:/x/new.js`" },
    { source: "MODEL", type: "DELETE_FILE", content: "File Path: `file:///C:/x/old.js`" },
    { source: "MODEL", type: "VIEW_FILE", content: "File Path: `file:///C:/x/read.js`" } // read → excluded
  ];
  assert.deepEqual(deriveFileChanges(steps), [
    { path: "C:/x/y.js", action: "modify" },
    { path: "C:/x/new.js", action: "create" },
    { path: "C:/x/old.js", action: "delete" }
  ]);
});

// ── normalizeAgyOutcome ─────────────────────────────────────────────────────

test("normalizeAgyOutcome: success maps conv-id, answer, status 0, no error", () => {
  const out = normalizeAgyOutcome({ logText: LOG, transcriptText: EXPLORE, exitCode: 0 });
  assert.equal(out.sessionId, "1b6eab11-dffb-48c6-bc75-cf29b8f5d8f7");
  assert.equal(out.status, 0);
  assert.equal(out.error, null);
  assert.match(out.text, /registry\.mjs/);
  assert.ok(out.toolCalls.length >= 3);
});

test("normalizeAgyOutcome: empty transcript yields an error and status 1", () => {
  const out = normalizeAgyOutcome({ logText: LOG, transcriptText: "", exitCode: 0 });
  assert.equal(out.status, 1);
  assert.equal(out.text, "");
  assert.match(out.error.message, /no answer/i);
  assert.equal(out.sessionId, "1b6eab11-dffb-48c6-bc75-cf29b8f5d8f7"); // still recovered from the log
});

test("normalizeAgyOutcome: stderr is surfaced when there is no answer", () => {
  const out = normalizeAgyOutcome({ logText: "", transcriptText: "", stderr: "Cannot use this model: bogus", exitCode: 1 });
  assert.equal(out.status, 1);
  assert.match(out.error.message, /Cannot use this model/);
});

test("normalizeAgyOutcome: timeout yields a timeout error and status 1", () => {
  const out = normalizeAgyOutcome({ logText: LOG, transcriptText: EXPLORE, timedOut: true });
  assert.equal(out.status, 1);
  assert.match(out.error.message, /timed out/i);
});

// ── adapter contract shape ──────────────────────────────────────────────────

test("adapter exports the required contract members with name 'antigravity'", () => {
  assert.equal(adapter.name, "antigravity");
  for (const fn of ["isAvailable", "isAuthenticated", "invoke", "cancel"]) {
    assert.equal(typeof adapter[fn], "function", `adapter.${fn} must be a function`);
  }
  assert.equal(adapter.getSession, undefined);
});

test("adapter.cancel reports the process-tree mechanism", async () => {
  const res = await adapter.cancel("job-xyz");
  assert.equal(res.attempted, true);
  assert.equal(res.transport, "process-tree");
  assert.match(res.detail, /job-xyz/);
});

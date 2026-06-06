// Pure-helper characterization tests for the codex adapter after the split into
// codex-roles-prompts.mjs / codex-render-parse.mjs / codex-transport.mjs.
// These import only the exported pure helpers from their owning submodule — never
// un-exported internals (and never the private `shorten`, which must stay off the
// public namespace).

import test from "node:test";
import assert from "node:assert/strict";

import {
  TASK_THREAD_PREFIX,
  buildThreadParams,
  buildResumeParams,
  buildTurnInput,
  buildTaskThreadName,
  buildPersistentTaskThreadName,
  withWindowsShellGuidance,
  WINDOWS_SHELL_GUIDANCE
} from "../../plugins/multi/scripts/lib/adapters/codex-roles-prompts.mjs";
import {
  parseStructuredOutput
} from "../../plugins/multi/scripts/lib/adapters/codex-render-parse.mjs";
import {
  looksLikeVerificationCommand,
  extractReasoningSections,
  mergeReasoningSections,
  collectTouchedFiles,
  buildResultStatus,
  extractThreadId,
  extractTurnId,
  resolveTurnInactivityMs
} from "../../plugins/multi/scripts/lib/adapters/codex-transport.mjs";
import {
  buildCodexConfigOverrides,
  buildCodexAppServerArgs
} from "../../plugins/multi/scripts/lib/app-server.mjs";

// ── parseStructuredOutput ─────────────────────────────────────────────────────

test("parseStructuredOutput: empty rawOutput returns default parse error and spreads fallback", () => {
  const result = parseStructuredOutput("");
  assert.equal(result.parsed, null);
  assert.equal(result.parseError, "Codex did not return a final structured message.");
  assert.equal(result.rawOutput, "");
});

test("parseStructuredOutput: empty rawOutput uses fallback.failureMessage when provided", () => {
  const result = parseStructuredOutput(null, { failureMessage: "custom failure", extra: 1 });
  assert.equal(result.parsed, null);
  assert.equal(result.parseError, "custom failure");
  assert.equal(result.rawOutput, "");
  assert.equal(result.extra, 1);
});

test("parseStructuredOutput: valid JSON parses with null parseError", () => {
  const result = parseStructuredOutput('{"a":1}', { foo: "bar" });
  assert.deepEqual(result.parsed, { a: 1 });
  assert.equal(result.parseError, null);
  assert.equal(result.rawOutput, '{"a":1}');
  assert.equal(result.foo, "bar");
});

test("parseStructuredOutput: invalid JSON returns the error message", () => {
  const result = parseStructuredOutput("{not json");
  assert.equal(result.parsed, null);
  assert.equal(typeof result.parseError, "string");
  assert.ok(result.parseError.length > 0);
  assert.equal(result.rawOutput, "{not json");
});

// ── buildTaskThreadName / buildPersistentTaskThreadName ───────────────────────

test("buildTaskThreadName: prefixes the shortened excerpt", () => {
  assert.equal(buildTaskThreadName("Fix the bug"), `${TASK_THREAD_PREFIX}: Fix the bug`);
});

test("buildTaskThreadName: blank prompt returns the bare prefix", () => {
  assert.equal(buildTaskThreadName("   "), TASK_THREAD_PREFIX);
  assert.equal(buildTaskThreadName(null), TASK_THREAD_PREFIX);
});

test("buildTaskThreadName: long prompt is truncated to a 56-char excerpt with ellipsis", () => {
  const longPrompt = "x".repeat(200);
  const name = buildTaskThreadName(longPrompt);
  const excerpt = name.slice(`${TASK_THREAD_PREFIX}: `.length);
  assert.equal(excerpt.length, 56);
  assert.ok(excerpt.endsWith("..."));
});

test("buildPersistentTaskThreadName delegates to buildTaskThreadName", () => {
  assert.equal(buildPersistentTaskThreadName("Fix the bug"), buildTaskThreadName("Fix the bug"));
});

// ── buildThreadParams / buildResumeParams / buildTurnInput ────────────────────

test("buildThreadParams: applies defaults and the service name", () => {
  const params = buildThreadParams("/work");
  assert.equal(params.cwd, "/work");
  assert.equal(params.model, null);
  assert.equal(params.approvalPolicy, "never");
  assert.equal(params.sandbox, "read-only");
  assert.equal(params.serviceName, "claude_code_codex_plugin");
  assert.equal(params.ephemeral, true);
  assert.equal(params.experimentalRawEvents, false);
});

test("buildThreadParams: honors provided options", () => {
  const params = buildThreadParams("/work", {
    model: "gpt-x",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    ephemeral: false
  });
  assert.equal(params.model, "gpt-x");
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.sandbox, "workspace-write");
  assert.equal(params.ephemeral, false);
});

test("buildResumeParams: applies defaults", () => {
  const params = buildResumeParams("thread-1", "/work");
  assert.equal(params.threadId, "thread-1");
  assert.equal(params.cwd, "/work");
  assert.equal(params.model, null);
  assert.equal(params.approvalPolicy, "never");
  assert.equal(params.sandbox, "read-only");
});

test("buildTurnInput: wraps the prompt in a text element", () => {
  assert.deepEqual(buildTurnInput("hello"), [{ type: "text", text: "hello", text_elements: [] }]);
});

// ── looksLikeVerificationCommand ──────────────────────────────────────────────

test("looksLikeVerificationCommand: matches test/lint/build verbs", () => {
  assert.equal(looksLikeVerificationCommand("npm test"), true);
  assert.equal(looksLikeVerificationCommand("eslint ."), true);
  assert.equal(looksLikeVerificationCommand("tsc --noEmit"), true);
  assert.equal(looksLikeVerificationCommand("pytest -q"), true);
});

test("looksLikeVerificationCommand: ignores unrelated commands", () => {
  assert.equal(looksLikeVerificationCommand("ls -la"), false);
  assert.equal(looksLikeVerificationCommand("git status"), false);
});

// ── extractReasoningSections ──────────────────────────────────────────────────

test("extractReasoningSections: empty/falsy returns []", () => {
  assert.deepEqual(extractReasoningSections(null), []);
  assert.deepEqual(extractReasoningSections(""), []);
});

test("extractReasoningSections: string is normalized", () => {
  assert.deepEqual(extractReasoningSections("  hello   world \n"), ["hello world"]);
});

test("extractReasoningSections: arrays flatten", () => {
  assert.deepEqual(extractReasoningSections(["a", "b"]), ["a", "b"]);
});

test("extractReasoningSections: object .text/.summary/.content/.parts shapes", () => {
  assert.deepEqual(extractReasoningSections({ text: "hi" }), ["hi"]);
  assert.deepEqual(extractReasoningSections({ summary: "sum" }), ["sum"]);
  assert.deepEqual(extractReasoningSections({ content: "con" }), ["con"]);
  assert.deepEqual(extractReasoningSections({ parts: ["p1", "p2"] }), ["p1", "p2"]);
});

// ── mergeReasoningSections ────────────────────────────────────────────────────

test("mergeReasoningSections: dedupes and normalizes, dropping blanks", () => {
  assert.deepEqual(
    mergeReasoningSections(["a"], ["a", "  b ", "", "b"]),
    ["a", "b"]
  );
});

// ── collectTouchedFiles ───────────────────────────────────────────────────────

test("collectTouchedFiles: returns unique change paths", () => {
  const fileChanges = [
    { changes: [{ path: "a.js" }, { path: "b.js" }] },
    { changes: [{ path: "a.js" }, { path: "c.js" }] },
    { changes: [{}] }
  ];
  assert.deepEqual(collectTouchedFiles(fileChanges), ["a.js", "b.js", "c.js"]);
});

test("collectTouchedFiles: tolerates missing changes arrays", () => {
  assert.deepEqual(collectTouchedFiles([{}]), []);
});

// ── buildResultStatus ─────────────────────────────────────────────────────────

test("buildResultStatus: completed turn -> 0, otherwise -> 1", () => {
  assert.equal(buildResultStatus({ finalTurn: { status: "completed" } }), 0);
  assert.equal(buildResultStatus({ finalTurn: { status: "failed" } }), 1);
  assert.equal(buildResultStatus({ finalTurn: null }), 1);
});

// ── extractThreadId / extractTurnId ───────────────────────────────────────────

test("extractThreadId: reads params.threadId or null", () => {
  assert.equal(extractThreadId({ params: { threadId: "t1" } }), "t1");
  assert.equal(extractThreadId({ params: {} }), null);
  assert.equal(extractThreadId(null), null);
});

test("extractTurnId: prefers params.turnId then params.turn.id then null", () => {
  assert.equal(extractTurnId({ params: { turnId: "u1" } }), "u1");
  assert.equal(extractTurnId({ params: { turn: { id: "u2" } } }), "u2");
  assert.equal(extractTurnId({ params: {} }), null);
  assert.equal(extractTurnId(null), null);
});

// ── withWindowsShellGuidance ──────────────────────────────────────────────────

test("withWindowsShellGuidance: prepends guidance and preserves prompt on win32", () => {
  const out = withWindowsShellGuidance("Fix the importer.", "win32");
  assert.ok(out.startsWith(WINDOWS_SHELL_GUIDANCE), "guidance is prepended");
  assert.ok(out.endsWith("Fix the importer."), "original prompt is preserved");
  assert.match(out, /PowerShell/);
  assert.match(out, /Git Bash/);
  assert.match(out, /-NoProfile/);
});

test("withWindowsShellGuidance: no-op off Windows", () => {
  assert.equal(withWindowsShellGuidance("Fix the importer.", "linux"), "Fix the importer.");
  assert.equal(withWindowsShellGuidance("Fix the importer.", "darwin"), "Fix the importer.");
});

test("withWindowsShellGuidance: passes through empty/undefined prompts unchanged", () => {
  assert.equal(withWindowsShellGuidance("", "win32"), "");
  assert.equal(withWindowsShellGuidance("   ", "win32"), "   ");
  assert.equal(withWindowsShellGuidance(undefined, "win32"), undefined);
  assert.equal(withWindowsShellGuidance(null, "win32"), null);
});

// ── buildCodexConfigOverrides / buildCodexAppServerArgs ───────────────────────

test("buildCodexConfigOverrides: forces non-login PowerShell on win32", () => {
  assert.deepEqual(buildCodexConfigOverrides("win32", {}), ["-c", "allow_login_shell=false"]);
});

test("buildCodexConfigOverrides: no win32 hardening off Windows", () => {
  assert.deepEqual(buildCodexConfigOverrides("linux", {}), []);
  assert.deepEqual(buildCodexConfigOverrides("darwin", {}), []);
});

test("buildCodexConfigOverrides: CODEX_COMPANION_NO_SHELL_HARDENING drops the win32 default", () => {
  assert.deepEqual(
    buildCodexConfigOverrides("win32", { CODEX_COMPANION_NO_SHELL_HARDENING: "1" }),
    []
  );
});

test("buildCodexConfigOverrides: appends extra key=value overrides (newline/semicolon separated)", () => {
  assert.deepEqual(
    buildCodexConfigOverrides("win32", { CODEX_COMPANION_CODEX_CONFIG: "model=\"gpt-5.4\"; foo.bar=1" }),
    ["-c", "allow_login_shell=false", "-c", 'model="gpt-5.4"', "-c", "foo.bar=1"]
  );
  assert.deepEqual(
    buildCodexConfigOverrides("linux", { CODEX_COMPANION_CODEX_CONFIG: "a=1\n\nb=2" }),
    ["-c", "a=1", "-c", "b=2"]
  );
});

test("buildCodexAppServerArgs: overrides precede the app-server subcommand", () => {
  assert.deepEqual(buildCodexAppServerArgs("win32", {}), ["-c", "allow_login_shell=false", "app-server"]);
  assert.deepEqual(buildCodexAppServerArgs("linux", {}), ["app-server"]);
});

// ── resolveTurnInactivityMs ───────────────────────────────────────────────────

test("resolveTurnInactivityMs: disabled (0) by default", () => {
  assert.equal(resolveTurnInactivityMs({}), 0);
  assert.equal(resolveTurnInactivityMs({ CODEX_COMPANION_TURN_INACTIVITY_MS: "" }), 0);
});

test("resolveTurnInactivityMs: parses a positive integer; rejects non-positive/garbage", () => {
  assert.equal(resolveTurnInactivityMs({ CODEX_COMPANION_TURN_INACTIVITY_MS: "900000" }), 900000);
  assert.equal(resolveTurnInactivityMs({ CODEX_COMPANION_TURN_INACTIVITY_MS: "0" }), 0);
  assert.equal(resolveTurnInactivityMs({ CODEX_COMPANION_TURN_INACTIVITY_MS: "-5" }), 0);
  assert.equal(resolveTurnInactivityMs({ CODEX_COMPANION_TURN_INACTIVITY_MS: "abc" }), 0);
});

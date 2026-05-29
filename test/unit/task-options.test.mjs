// Characterization tests for the task-option normalizers extracted from the
// companion. These pin the behavior the live forwarders depend on (spark alias,
// effort validation) so future refactors can't silently change it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_ALIASES,
  normalizeArgv,
  normalizeReasoningEffort,
  normalizeRequestedModel,
} from "../../plugins/multi/scripts/lib/task-options.mjs";

test("normalizeRequestedModel maps the spark alias (case-insensitive)", () => {
  assert.equal(normalizeRequestedModel("spark"), "gpt-5.3-codex-spark");
  assert.equal(normalizeRequestedModel("SPARK"), "gpt-5.3-codex-spark");
});

test("normalizeRequestedModel trims and passes through unknown models", () => {
  assert.equal(normalizeRequestedModel("  gpt-5.5  "), "gpt-5.5");
});

test("normalizeRequestedModel returns null for empty/nullish input", () => {
  assert.equal(normalizeRequestedModel(null), null);
  assert.equal(normalizeRequestedModel("   "), null);
});

test("normalizeReasoningEffort accepts valid levels (case-insensitive)", () => {
  assert.equal(normalizeReasoningEffort("HIGH"), "high");
  assert.equal(normalizeReasoningEffort("minimal"), "minimal");
});

test("normalizeReasoningEffort throws a clear error on an invalid level", () => {
  assert.throws(() => normalizeReasoningEffort("bogus"), /Unsupported reasoning effort/);
});

test("normalizeReasoningEffort returns null for nullish input", () => {
  assert.equal(normalizeReasoningEffort(null), null);
});

test("normalizeArgv splits a single raw string into tokens", () => {
  assert.ok(normalizeArgv(["--write hello world"]).length > 1);
});

test("normalizeArgv passes a multi-arg array through unchanged", () => {
  assert.deepEqual(normalizeArgv(["a", "b"]), ["a", "b"]);
});

test("normalizeArgv returns [] for a single empty string", () => {
  assert.deepEqual(normalizeArgv([""]), []);
});

test("MODEL_ALIASES exposes the spark mapping", () => {
  assert.equal(MODEL_ALIASES.get("spark"), "gpt-5.3-codex-spark");
});

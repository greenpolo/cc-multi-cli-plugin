// Characterization tests for the task-option normalizers extracted from the
// companion. These pin the behavior the live forwarders depend on (model
// pass-through, effort validation) so future refactors can't silently change it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_ALIASES,
  normalizeArgv,
  normalizeReasoningEffort,
  normalizeRequestedModel,
  resolveTaskRouting,
} from "../../plugins/multi/scripts/lib/task-options.mjs";

test("normalizeRequestedModel trims and passes through unknown models verbatim", () => {
  assert.equal(normalizeRequestedModel("  gpt-5.5  "), "gpt-5.5");
  assert.equal(normalizeRequestedModel("spark"), "spark");
});

test("normalizeRequestedModel returns null for empty/nullish input", () => {
  assert.equal(normalizeRequestedModel(null), null);
  assert.equal(normalizeRequestedModel("   "), null);
});

test("normalizeReasoningEffort accepts valid levels (case-insensitive)", () => {
  assert.equal(normalizeReasoningEffort("HIGH"), "high");
  assert.equal(normalizeReasoningEffort("minimal"), "minimal");
  assert.equal(normalizeReasoningEffort("MAX"), "max");
  assert.equal(normalizeReasoningEffort("ultra"), "ultra");
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

test("MODEL_ALIASES has no aliases (spark removed; slugs pass through)", () => {
  assert.equal(MODEL_ALIASES.size, 0);
});

test("resolveTaskRouting maps task kinds to codex model/effort defaults", () => {
  assert.deepEqual(resolveTaskRouting({ kind: "spec" }), {
    model: "gpt-5.6-terra",
    effort: "medium"
  });
  assert.deepEqual(resolveTaskRouting({ kind: " Open-Ended " }), {
    model: "gpt-5.6-sol",
    effort: "medium"
  });
});

test("resolveTaskRouting lets explicit model/effort win over the kind defaults", () => {
  assert.deepEqual(
    resolveTaskRouting({ kind: "spec", model: "gpt-5.6-sol", effort: "xhigh" }),
    { model: "gpt-5.6-sol", effort: "xhigh" }
  );
  // Partial override: only the unset side gets the default.
  assert.deepEqual(resolveTaskRouting({ kind: "open-ended", effort: "high" }), {
    model: "gpt-5.6-sol",
    effort: "high"
  });
});

test("resolveTaskRouting defaults nothing without a kind or for non-codex CLIs", () => {
  assert.deepEqual(resolveTaskRouting({}), { model: null, effort: null });
  assert.deepEqual(resolveTaskRouting({ cli: "cursor", kind: "spec" }), {
    model: null,
    effort: null
  });
});

test("resolveTaskRouting rejects an unknown task kind", () => {
  assert.throws(() => resolveTaskRouting({ kind: "vibes" }), /Unsupported --task-kind/);
});

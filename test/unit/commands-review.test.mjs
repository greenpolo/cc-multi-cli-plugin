import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAdversarialReviewPrompt,
  buildNativeReviewTarget,
  buildReviewJobMetadata,
  validateNativeReviewRequest
} from "../../plugins/multi/scripts/lib/commands/review.mjs";

test("buildNativeReviewTarget maps review modes to native targets", () => {
  assert.deepEqual(buildNativeReviewTarget({ mode: "working-tree" }), {
    type: "uncommittedChanges"
  });
  assert.deepEqual(buildNativeReviewTarget({ mode: "branch", baseRef: "main" }), {
    type: "baseBranch",
    branch: "main"
  });
  assert.equal(buildNativeReviewTarget({ mode: "commit" }), null);
});

test("validateNativeReviewRequest rejects custom focus text", () => {
  assert.throws(
    () => validateNativeReviewRequest({ mode: "working-tree" }, "look at auth"),
    /does not support custom focus text/
  );
});

test("validateNativeReviewRequest rejects unsupported targets", () => {
  assert.throws(
    () => validateNativeReviewRequest({ mode: "commit" }, ""),
    /not supported by the built-in reviewer/
  );
});

test("validateNativeReviewRequest returns the native target for a valid request", () => {
  assert.deepEqual(validateNativeReviewRequest({ mode: "working-tree" }, ""), {
    type: "uncommittedChanges"
  });
  assert.deepEqual(
    validateNativeReviewRequest({ mode: "branch", baseRef: "develop" }, "   "),
    { type: "baseBranch", branch: "develop" }
  );
});

test("buildReviewJobMetadata builds adversarial-review metadata", () => {
  const target = { label: "working tree" };
  assert.deepEqual(buildReviewJobMetadata("Adversarial Review", target), {
    kind: "adversarial-review",
    title: "Codex Adversarial Review",
    summary: "Adversarial Review working tree"
  });
});

test("buildReviewJobMetadata builds review metadata", () => {
  const target = { label: "branch main" };
  assert.deepEqual(buildReviewJobMetadata("Review", target), {
    kind: "review",
    title: "Codex Review",
    summary: "Review branch main"
  });
});

test("buildAdversarialReviewPrompt fills the focus placeholder default", () => {
  const context = {
    target: { label: "working tree" },
    collectionGuidance: "Use git status.",
    content: "diff goes here"
  };
  // Empty focus text falls back to the default sentinel; this also exercises the
  // real prompt-template load, which depends on a correct ROOT_DIR base path.
  const prompt = buildAdversarialReviewPrompt(context, "");
  assert.match(prompt, /User focus: No extra focus provided\./);
  assert.match(prompt, /Target: working tree/);
  assert.match(prompt, /diff goes here/);
  assert.match(prompt, /Use git status\./);
});

test("buildAdversarialReviewPrompt interpolates provided focus text", () => {
  const context = {
    target: { label: "branch feature" },
    collectionGuidance: "",
    content: "context body"
  };
  const prompt = buildAdversarialReviewPrompt(context, "check the auth path");
  assert.match(prompt, /User focus: check the auth path/);
});

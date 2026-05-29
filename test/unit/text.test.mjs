import test from "node:test";
import assert from "node:assert/strict";

import { firstMeaningfulLine, shorten } from "../../plugins/multi/scripts/lib/text.mjs";

test("shorten collapses internal whitespace", () => {
  assert.equal(shorten("a   b\n\tc"), "a b c");
});

test("shorten truncates with an ellipsis past the limit", () => {
  assert.equal(shorten("abcdefghij", 8), "abcde...");
  assert.equal(shorten("abcdefghij", 8).length, 8);
});

test("shorten returns the string unchanged when within the limit", () => {
  assert.equal(shorten("short", 96), "short");
});

test("shorten returns empty string for nullish/blank input", () => {
  assert.equal(shorten(null), "");
  assert.equal(shorten("   "), "");
});

test("firstMeaningfulLine returns the first non-blank trimmed line", () => {
  assert.equal(firstMeaningfulLine("\n\n   \n  hello \nworld"), "hello");
});

test("firstMeaningfulLine falls back when there is no content", () => {
  assert.equal(firstMeaningfulLine("   \n\t", "fallback"), "fallback");
  assert.equal(firstMeaningfulLine(null, "fb"), "fb");
});

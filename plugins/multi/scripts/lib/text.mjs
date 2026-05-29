// Pure text/formatting helpers used across companion command rendering.
// Extracted from multi-cli-companion.mjs; unit-tested in test/unit/text.test.mjs.

/**
 * Collapse internal whitespace and truncate to `limit` characters, appending an
 * ellipsis when truncated. Returns "" for nullish/blank input.
 */
export function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

/**
 * First non-empty, trimmed line of `text`, or `fallback` if there is none.
 */
export function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

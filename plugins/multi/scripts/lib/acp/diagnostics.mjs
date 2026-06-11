/**
 * Diagnostic-message sanitizer for the ACP turn runner (lib/acp/client.mjs).
 *
 * Copied verbatim from the legacy `lib/acp-diagnostics.mjs` (the only function
 * the runner needs) so the slice-1 ACP layer has no dependency on the
 * pre-retreat files slated for deletion. Keeps diagnostics bounded, strips ANSI
 * / control bytes, and collapses whitespace — diagnostics carry methods, tool
 * names, and errors only, never prompt content.
 */

/** Hard cap on a single sanitized diagnostic line. */
export const MAX_DIAGNOSTIC_LENGTH = 500;

/**
 * Strip ANSI escape sequences and control characters from an arbitrary value,
 * collapse whitespace, and truncate to {@link MAX_DIAGNOSTIC_LENGTH}.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeDiagnosticMessage(value) {
  return String(value ?? "")
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g, "")
    .replace(/\u001b[PX^_][\s\S]*?(?:\u001b\\|$)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

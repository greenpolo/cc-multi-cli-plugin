/**
 * Antigravity adapter — STUB (Phase 1).
 *
 * The real transport (live-attach to the Antigravity 2.0 desktop Language
 * Server via ConnectRPC) is implemented in Phase 2. This stub conforms to the
 * adapter interface so the companion's dispatch, job tracking, and subagent
 * forwarding can be wired and tested before the transport exists.
 *
 * See docs/superpowers/specs/2026-05-24-plugin-rebuild-design.md §5.
 */

import { execSync } from "node:child_process";

const PHASE2_MESSAGE =
  "Antigravity adapter is not implemented yet (Phase 2). It will live-attach to " +
  "the running Antigravity 2.0 desktop Language Server. For now, /antigravity:* " +
  "commands are scaffolded but non-functional.";

/**
 * Best-effort detection of a running Antigravity 2.0 desktop process.
 * Phase 2 replaces this with real LS discovery (CSRF token + port extraction).
 * @returns {{ available: boolean, detail: string, version: string | null }}
 */
export function getAntigravityAvailability() {
  // Windows-first: look for an Antigravity-spawned language server process.
  if (process.platform === "win32") {
    try {
      const out = execSync(
        'powershell -NoProfile -Command "Get-Process | Where-Object { $_.Path -like \'*Antigravity*\' } | Select-Object -First 1 -ExpandProperty Path"',
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 8000 }
      ).trim();
      if (out) {
        return { available: true, detail: `Antigravity desktop detected: ${out}`, version: null };
      }
    } catch {
      // fall through
    }
    return {
      available: false,
      detail: "Antigravity 2.0 desktop not detected. Install from https://antigravity.google and sign in, then keep it running.",
      version: null
    };
  }
  return {
    available: false,
    detail: "Antigravity adapter only supports Windows discovery in this release (Phase 2 adds macOS/Linux).",
    version: null
  };
}

export function getAntigravityAuthStatus() {
  // Phase 2: probe the LS GetUserStatus RPC. For now, mirror availability.
  const avail = getAntigravityAvailability();
  return {
    authenticated: false,
    loggedIn: false,
    method: null,
    detail: avail.available
      ? "Antigravity desktop detected, but the LS transport is not implemented (Phase 2)."
      : avail.detail
  };
}

/**
 * Stub invoke — always returns a structured not-implemented error.
 * Shape matches the other adapters' invoke() return so dispatch code is uniform.
 */
export async function runAntigravityPrompt(_cwd, _prompt, _options = {}) {
  return {
    sessionId: null,
    text: "",
    chunkCount: 0,
    chunkChars: 0,
    toolCalls: [],
    fileChanges: [],
    error: new Error(PHASE2_MESSAGE)
  };
}

export async function interruptAntigravityPrompt(jobId) {
  return {
    attempted: false,
    interrupted: false,
    transport: null,
    detail: `Cancel not implemented for Antigravity (stub). jobId: ${jobId}`
  };
}

export const adapter = {
  name: "antigravity",
  isAvailable: getAntigravityAvailability,
  isAuthenticated: getAntigravityAuthStatus,
  invoke: runAntigravityPrompt,
  cancel: interruptAntigravityPrompt,
  getSession: undefined
};

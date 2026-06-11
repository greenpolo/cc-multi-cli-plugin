/**
 * Win32-first spawn resolution for the two ACP targets (OpenCode + Cursor).
 *
 * The ACP SDK ships no spawn helpers, so locating the real executable is ours.
 * Both resolvers:
 *   - honor the existing operator overrides used by the headless adapters
 *     (`OPENCODE_CLI_PATH`, `CURSOR_AGENT_PATH`) so the transport flip needs no
 *     new env vars;
 *   - return `{ exe, args }` on success and `{ exe: null, detail }` (NOT a throw)
 *     when the binary cannot be found, so the caller can surface a clean
 *     configuration error;
 *   - fall back to the bare binary name on non-win32 (trusting PATH).
 *
 * Paths are built with node:path only (no string concatenation), per the win32
 * path-handling constraint.
 */

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/** Normalize a user-supplied path to forward slashes (matches the adapters). */
function normalizeOverride(value) {
  return String(value).replace(/\\/g, "/");
}

/**
 * Resolve the OpenCode ACP spawn spec.
 *
 * win32: the real platform exe lives under the npm install at
 *   %APPDATA%\npm\node_modules\opencode-ai\node_modules\opencode-windows-x64\bin\opencode.exe
 * with a `-baseline` sibling on some CPUs. We probe the override first, then the
 * platform exe, then the baseline exe. args are always `["acp"]` plus the
 * diagnostic log flags (INFO stderr names the live model — see the blueprint).
 *
 * Non-win32: bare `"opencode"` + the acp args, trusting PATH.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, homedir?: string }} [opts]
 * @returns {{ exe: string, args: string[] } | { exe: null, detail: string }}
 */
export function resolveOpenCodeAcp(opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const args = ["acp", "--print-logs", "--log-level", "INFO"];

  // Operator override always wins (same env var the headless adapter honors).
  if (env.OPENCODE_CLI_PATH && String(env.OPENCODE_CLI_PATH).trim()) {
    return { exe: normalizeOverride(env.OPENCODE_CLI_PATH), args };
  }

  if (platform !== "win32") {
    return { exe: "opencode", args };
  }

  const home = opts.homedir ?? env.USERPROFILE ?? env.HOME ?? os.homedir();
  const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const binDir = path.join(
    appData,
    "npm",
    "node_modules",
    "opencode-ai",
    "node_modules",
    "opencode-windows-x64",
    "bin"
  );
  const candidates = [
    path.join(binDir, "opencode.exe"),
    path.join(binDir, "opencode-baseline.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { exe: normalizeOverride(candidate), args };
    }
  }

  return {
    exe: null,
    detail:
      `OpenCode ACP executable not found. Looked for ${candidates.join(" and ")}. ` +
      `Install OpenCode (\`npm install -g opencode-ai\`) or set OPENCODE_CLI_PATH.`,
  };
}

/**
 * Pick the lexically-latest `^\d{4}\.`-prefixed version directory under a Cursor
 * versions dir, ignoring non-date dirs (e.g. "dist-package"). Cursor self-updates
 * in the background, so the newest date dir is the live build. Returns null when
 * the dir is missing or has no date dirs.
 *
 * @param {string} versionsDir
 * @returns {string | null} the directory NAME (not the full path)
 */
export function pickLatestCursorVersionDir(versionsDir) {
  let entries;
  try {
    entries = readdirSync(versionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dateDirs = entries
    .filter((e) => e.isDirectory() && /^\d{4}\./.test(e.name))
    .map((e) => e.name)
    .sort();
  return dateDirs.length ? dateDirs[dateDirs.length - 1] : null;
}

/**
 * Resolve the Cursor ACP spawn spec.
 *
 * win32: Cursor bundles its own Node runtime per version under
 *   %LOCALAPPDATA%\cursor-agent\versions\<ver>\
 * We spawn that node.exe with `<ver>\index.js acp`. `<ver>` is resolved
 * dynamically (latest date dir) because it churns via background self-update.
 *
 * The CURSOR_AGENT_PATH override (the env var the headless adapter honors) points
 * at a single launcher binary — when set we use it directly with `["acp"]` (no
 * separate node.exe), so an operator can pin any build.
 *
 * Non-win32: bare `"cursor-agent"` + `["acp"]`, trusting PATH.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, homedir?: string }} [opts]
 * @returns {{ exe: string, args: string[] } | { exe: null, detail: string }}
 */
export function resolveCursorAcp(opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;

  // Operator override always wins. The override is a single launcher binary, so
  // it takes the bare acp subcommand (no bundled node.exe split).
  if (env.CURSOR_AGENT_PATH && String(env.CURSOR_AGENT_PATH).trim()) {
    return { exe: normalizeOverride(env.CURSOR_AGENT_PATH), args: ["acp"] };
  }

  if (platform !== "win32") {
    return { exe: "cursor-agent", args: ["acp"] };
  }

  const home = opts.homedir ?? env.USERPROFILE ?? env.HOME ?? os.homedir();
  const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const versionsDir = path.join(localAppData, "cursor-agent", "versions");
  const ver = pickLatestCursorVersionDir(versionsDir);
  if (!ver) {
    return {
      exe: null,
      detail:
        `Cursor ACP runtime not found. No version directory under ${versionsDir}. ` +
        `Install cursor-agent or set CURSOR_AGENT_PATH.`,
    };
  }
  const verDir = path.join(versionsDir, ver);
  const node = path.join(verDir, "node.exe");
  const indexJs = path.join(verDir, "index.js");
  if (!existsSync(node) || !existsSync(indexJs)) {
    return {
      exe: null,
      detail:
        `Cursor ACP runtime under ${verDir} is incomplete ` +
        `(expected node.exe + index.js). Reinstall cursor-agent or set CURSOR_AGENT_PATH.`,
    };
  }
  return { exe: normalizeOverride(node), args: [normalizeOverride(indexJs), "acp"] };
}

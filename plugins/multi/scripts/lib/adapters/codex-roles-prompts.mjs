import process from "node:process";

const SERVICE_NAME = "claude_code_codex_plugin";
export const TASK_THREAD_PREFIX = "Codex Companion Task";

// On Windows, codex picks its own command-execution shell. It can auto-detect
// Git Bash (`/usr/bin/bash`) and then mangle prompts that contain code: markdown
// backticks become command substitution, `$(...)`/`&`/`<`/`>` become syntax
// errors. It also runs PowerShell with profile loading by default, which can hang
// non-interactively. We pin -NoProfile via config (see buildCodexConfigOverrides)
// and steer the model toward PowerShell + file-based scripts with this preamble.
export const WINDOWS_SHELL_GUIDANCE = [
  "EXECUTION ENVIRONMENT — Windows host. Follow these shell rules:",
  "- Run commands through PowerShell (pwsh). Do NOT use Git Bash, WSL, or `/usr/bin/bash`/`bash -lc`; on this machine bash mangles code-bearing commands.",
  "- PowerShell is launched with `-NoProfile`; rely on absolute paths / PATH, not on profile aliases. Do not try to re-enable the profile.",
  "- Never paste multi-line code (Groovy, Java, Python, etc.) directly into a `-Command` string, a `bash -c` argument, or a heredoc — text containing backticks, `$(...)`, `&`, `<`, or `>` will be reinterpreted by the shell and fail. Instead write the script to a file (apply_patch or `Set-Content`), then execute that file.",
  "- Quote literal PowerShell strings with single quotes, and use `--%` to stop PowerShell from parsing trailing native-command arguments.",
  ""
].join("\n");

/**
 * Prepend Windows shell-hygiene guidance to a codex prompt on win32. Pure: the
 * platform is injectable for tests. Returns the prompt unchanged off-Windows or
 * when there is no prompt text (resume turns pass an empty/undefined prompt).
 */
export function withWindowsShellGuidance(prompt, platform = process.platform) {
  const text = typeof prompt === "string" ? prompt : "";
  if (platform !== "win32" || !text.trim()) {
    return prompt;
  }
  return `${WINDOWS_SHELL_GUIDANCE}\n${text}`;
}
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

/** @returns {ThreadStartParams} */
export function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true,
    experimentalRawEvents: false
  };
}

/** @returns {ThreadResumeParams} */
export function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  };
}

/** @returns {UserInput[]} */
export function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

export function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

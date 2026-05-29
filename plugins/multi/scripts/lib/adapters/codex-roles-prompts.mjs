const SERVICE_NAME = "claude_code_codex_plugin";
export const TASK_THREAD_PREFIX = "Codex Companion Task";
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

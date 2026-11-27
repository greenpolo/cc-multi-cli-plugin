/**
 * Turns a Codex failure into one actionable sentence. Codex's own message already says
 * what happened (a spent plan window says when it resets); this adds the move to make.
 */
const ADVICE: readonly { match: RegExp; advice: string }[] = [
  {
    match: /unauthorized|not (?:logged|signed) in|log ?in again|refresh token|401/i,
    advice: 'Run codex login in your own terminal, then retry.',
  },
  {
    match: /no rollout found|thread .*not found/i,
    advice: 'The Codex thread is gone. Start a new conversation; Multi never rewinds native state.',
  },
  {
    match: /ENOENT|not recognized|command not found/i,
    advice:
      'Install the Codex CLI (npm install -g @openai/codex) and make codex available on PATH.',
  },
];

export function codexFailureAdvice(message: string): string | undefined {
  return ADVICE.find(({ match }) => match.test(message))?.advice;
}

/** Codex errors that fail the same way until something changes, so retrying only waits. */
export const DETERMINISTIC_CODEX_ERRORS = new Set([
  'usageLimitExceeded',
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'unauthorized',
  'badRequest',
  'modelNotFound',
  'cyberPolicy',
  'bioPolicy',
  'misalignmentPolicyViolation',
]);

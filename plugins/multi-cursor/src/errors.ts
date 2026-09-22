import type { RunResult } from '@cursor/sdk';
import { HarnessBusyError } from '../../multi-core/src/gateway/harness-session.ts';

interface CursorFailure {
  status: number;
  code?: string;
  requestId?: string;
  message: string;
}

// SDK 1.0.31 serializes terminal failures to message/code, dropping class/status.
// Preserve the known backend and ConnectRPC codes at that boundary.
const CODE_STATUS: Record<string, number> = {
  auth_token_expired: 401,
  auth_token_not_found: 401,
  not_logged_in: 401,
  invalid_auth_id: 401,
  agent_requires_login: 401,
  unauthorized: 401,
  unauthenticated: 401,
  not_high_enough_permissions: 403,
  permission_denied: 403,
  rate_limited: 429,
  rate_limited_changeable: 429,
  resource_exhausted: 429,
  free_user_rate_limit_exceeded: 429,
  pro_user_rate_limit_exceeded: 429,
  free_user_usage_limit: 429,
  pro_user_usage_limit: 429,
  openai_rate_limit_exceeded: 429,
  generic_rate_limit_exceeded: 429,
  gpt_4_vision_preview_rate_limit: 429,
  api_key_rate_limit: 429,
  timeout: 503,
  unavailable: 503,
  deadline_exceeded: 503,
  bad_model_name: 400,
  model_blocked: 400,
  bad_request: 400,
  invalid_argument: 400,
  context_length_exceeded: 400,
  context_window_exceeded: 400,
  aborted: 499,
  abort_err: 499,
  cancelled: 499,
  canceled: 499,
};
const NAME_STATUS: Record<string, number> = {
  AuthenticationError: 401,
  RateLimitError: 429,
  NetworkError: 503,
  ConfigurationError: 400,
  AbortError: 499,
};

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/** Redact before truncating so partial credentials cannot survive a length limit. */
export function sanitizeCursorErrorMessage(value: unknown): string {
  const text = String(value ?? 'unknown Cursor SDK failure');
  const apiKey = process.env.CURSOR_API_KEY;
  return (
    (apiKey ? text.split(apiKey).join('[redacted]') : text)
      .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/([?&](?:api[_-]?key|token|access_token|refresh_token)=)[^&\s]+/gi, '$1[redacted]')
      .replace(/(https?:\/\/)([^/@\s]+)@/gi, '$1[redacted]@')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: diagnostics must remove terminal control bytes.
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500)
  );
}

export function cursorFailure(error: unknown): CursorFailure {
  if (error instanceof HarnessBusyError) {
    // Deterministic, not retryable: the prompt was composed before the running
    // turn answered, so a retry would forward that turn's stale history again.
    return { status: 400, message: sanitizeCursorErrorMessage(error.message) };
  }
  const fields =
    error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const code = stringField(fields, 'code');
  const name = stringField(fields, 'name') ?? '';
  const requestId = stringField(fields, 'requestId');
  const explicitStatus = fields.status;
  const status =
    typeof explicitStatus === 'number' &&
    [400, 401, 403, 404, 409, 429, 499, 503, 504].includes(explicitStatus)
      ? explicitStatus
      : undefined;
  return {
    status:
      status ??
      (Object.hasOwn(CODE_STATUS, code?.toLowerCase() ?? '')
        ? CODE_STATUS[code?.toLowerCase() ?? '']
        : undefined) ??
      (Object.hasOwn(NAME_STATUS, name) ? NAME_STATUS[name] : 502),
    code: code ? sanitizeCursorErrorMessage(code).slice(0, 80) : undefined,
    requestId: requestId ? sanitizeCursorErrorMessage(requestId).slice(0, 120) : undefined,
    message: sanitizeCursorErrorMessage(stringField(fields, 'message') ?? error),
  };
}

export class CursorProviderError extends Error {
  readonly failure: CursorFailure;

  constructor(error: unknown) {
    const failure = cursorFailure(error);
    const detail = [
      failure.code && `code ${failure.code}`,
      failure.requestId && `request ${failure.requestId}`,
    ]
      .filter(Boolean)
      .join(' · ');
    super(detail ? `${failure.message} (${detail})` : failure.message, { cause: error });
    this.name = 'CursorProviderError';
    this.failure = failure;
  }
}

export function cursorRunError(result: RunResult): CursorProviderError {
  return new CursorProviderError({
    ...result.error,
    code: result.error?.code ?? (result.status === 'cancelled' ? 'cancelled' : undefined),
    message: result.error?.message ?? `Cursor run ${result.status}`,
    requestId: result.requestId,
  });
}

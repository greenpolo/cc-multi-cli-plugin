import type { NativeProgressObserver } from './harness-progress.ts';
import type { Emit, MessagesRequest, MessagesResponse } from './messages.ts';
import type { PermissionContext } from './mode-hook.ts';

/** The gateway contract implemented by provider-owned native harnesses. */
export interface NativeHarness {
  validate(body: MessagesRequest, context?: PermissionContext): number;
  handle(
    body: MessagesRequest,
    scope: string,
    signal: AbortSignal,
    emit?: Emit,
    context?: PermissionContext,
    observe?: NativeProgressObserver,
  ): Promise<MessagesResponse>;
  /**
   * The scope's last reply as its durable native session record holds it, read
   * without running anything, so a reply's deferred answer survives a restart.
   */
  recordedResponse?(
    scope: string,
    context?: PermissionContext,
  ): Promise<MessagesResponse | undefined>;
}

/** Provider failures expose an HTTP status without coupling core to their classes. */
export function nativeHarnessErrorStatus(error: unknown): number | undefined {
  return statusFrom(error, new Set());
}

function statusFrom(error: unknown, seen: Set<object>): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  if (seen.has(error) || seen.size >= 8) {
    return undefined;
  }
  seen.add(error);
  if ('failure' in error) {
    const failure = error.failure;
    if (typeof failure === 'object' && failure !== null && 'status' in failure) {
      return typeof failure.status === 'number' &&
        Number.isInteger(failure.status) &&
        failure.status >= 400 &&
        failure.status <= 599
        ? failure.status
        : undefined;
    }
  }
  return 'cause' in error ? statusFrom(error.cause, seen) : undefined;
}

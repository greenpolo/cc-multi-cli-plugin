import type { JsonObject, UpstreamRequest } from './types.ts';

/** Claude Code names its worker tool Agent; older builds call it Task. */
export function workerTool(request: UpstreamRequest): string {
  return (request.body.tools as JsonObject[]).some((tool) => tool.name === 'Agent')
    ? 'Agent'
    : 'Task';
}

/** The worker ID Claude returned from the most recent Agent launch. */
export function workerId(request: UpstreamRequest): string {
  const messages = JSON.stringify(request.body.messages);
  const match = messages.match(/agentId:\\?n?\s*([a-zA-Z0-9_-]+)/);
  if (!match?.[1]) {
    throw new Error(`No resumable worker ID in ${messages.slice(-4000)}`);
  }
  return match[1];
}

/**
 * Background workers finish asynchronously. A SendMessage sent before the completion
 * notification is only queued for the worker's next tool round, which a finished
 * no-tool turn never has, so scripts wait for this before resuming a worker.
 */
export function workerCompletions(request: UpstreamRequest, id: string): number {
  const messages = JSON.stringify(request.body.messages);
  const pattern = new RegExp(`<task-id>${id}</task-id>[\\s\\S]*?<status>completed</status>`, 'g');
  return messages.match(pattern)?.length ?? 0;
}

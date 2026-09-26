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

function strings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

/**
 * Pick a provider's worker from Claude's wire-visible registration reminder, not a
 * production catalog. Main registers one legacy type per model with the model bound in
 * its definition (`openai-native` is the provider default); the per-provider layout
 * registers `multi-<provider>` and takes the model through the Agent `model` parameter.
 * Never silently fall back to a Claude worker.
 */
export function registeredWorker(request: UpstreamRequest, provider: string, model?: string) {
  const reminder = strings(request.body.messages)
    .filter((text) => text.includes('Available agent types for the Agent tool:'))
    .join('\n');
  const entries = [...reminder.matchAll(/^- ([\w.-]+): (.*)$/gm)].map((match) => ({
    name: match[1] ?? '',
    description: match[2] ?? '',
  }));
  if (entries.some((entry) => entry.name === `multi-${provider}`)) {
    return {
      subagent_type: `multi-${provider}`,
      ...(model ? { model: `multi/${provider}/${model}` } : {}),
    };
  }
  const legacy = entries
    .filter((entry) =>
      model
        ? entry.name.startsWith(`${provider}-`) &&
          (entry.description.includes(model) ||
            entry.name === `${provider}-${model}` ||
            entry.name === model)
        : entry.name === `${provider}-native`,
    )
    .sort((left, right) => left.name.length - right.name.length)[0];
  if (!legacy) {
    throw new Error(
      `No advertised ${provider} worker for ${model ?? 'the default model'}: ${entries.map((entry) => entry.name).join(', ')}`,
    );
  }
  return { subagent_type: legacy.name };
}

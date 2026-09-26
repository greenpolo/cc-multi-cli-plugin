import assert from 'node:assert/strict';
import type { UpstreamRequest } from '../../types.ts';

function strings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

/** Use Claude's wire-visible registration reminder, not a production catalog.
 * Legacy registrations bind the model in their definition; provider registrations
 * require an explicit Agent model override. Never silently fall back to Claude. */
export function registeredWorker(request: UpstreamRequest, provider: string, model: string) {
  const reminder = strings(request.body.messages)
    .filter((text) => text.includes('Available agent types for the Agent tool:'))
    .join('\n');
  const entries = [...reminder.matchAll(/^- ([\w.-]+): (.*)$/gm)].map((match) => ({
    name: match[1],
    description: match[2],
  }));
  const providerWorker = entries.find((entry) => entry.name === `multi-${provider}`);
  if (providerWorker) {
    return { subagent_type: providerWorker.name, model: `multi/${provider}/${model}` };
  }
  const legacy = entries
    .filter(
      (entry) =>
        entry.name.startsWith(`${provider}-`) &&
        (entry.description.includes(model) ||
          entry.name === `${provider}-${model}` ||
          entry.name === model),
    )
    .sort((left, right) => left.name.length - right.name.length)[0];
  assert.ok(
    legacy,
    `No advertised ${provider} worker for ${model}: ${entries.map((entry) => entry.name).join(', ')}`,
  );
  return { subagent_type: legacy.name };
}

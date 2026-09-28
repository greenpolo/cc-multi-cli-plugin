import type { ResponseContentBlock } from './messages.ts';

type ToolVerdict =
  | { type: 'unavailable'; reason: 'error' }
  | { type: 'evaluated'; outcome: 'not_flagged' }
  | { type: 'evaluated'; outcome: 'flagged'; explanation: string };

export type SafeguardResults = [
  {
    type: 'dangerous_tool_use';
    status: { type: 'available'; tool_uses: Record<string, ToolVerdict> };
  },
];

export type SafeguardProvider = 'openai' | 'zen' | 'native';

const zenUnreviewedModes = new Set([
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A malformed request cannot authorize a synthetic verdict. */
export function dangerousToolMode(safeguards: unknown): string | undefined {
  if (!Array.isArray(safeguards) || !safeguards.every(record)) {
    return undefined;
  }
  const entry = safeguards.find((item) => item.type === 'dangerous_tool_use');
  if (!entry) {
    return undefined;
  }
  const context = entry.classifier_context;
  return record(context) && typeof context.permission_mode === 'string'
    ? context.permission_mode
    : '';
}

export function safeguardResults(
  safeguards: unknown,
  content: readonly ResponseContentBlock[],
  provider: SafeguardProvider,
): SafeguardResults | undefined {
  const mode = dangerousToolMode(safeguards);
  return buildResults(mode !== undefined, mode, content, provider);
}

/** Restored native runs retain whether the original request asked for results. */
export function restoredNativeSafeguardResults(
  requested: boolean,
  content: readonly ResponseContentBlock[],
): SafeguardResults | undefined {
  return buildResults(requested, undefined, content, 'native');
}

function buildResults(
  requested: boolean,
  mode: string | undefined,
  content: readonly ResponseContentBlock[],
  provider: SafeguardProvider,
): SafeguardResults | undefined {
  if (!requested) {
    return undefined;
  }
  let verdict: ToolVerdict = { type: 'evaluated', outcome: 'not_flagged' };
  if (provider === 'openai') {
    verdict = { type: 'unavailable', reason: 'error' };
  } else if (provider === 'zen' && !zenUnreviewedModes.has(mode ?? '')) {
    const explanation =
      mode === 'plan'
        ? 'Plan mode: Zen has no reviewer, so actions that need review are refused.'
        : 'Zen permission mode is unavailable or unknown, so actions that need review are refused.';
    verdict = {
      type: 'evaluated',
      outcome: 'flagged',
      explanation,
    };
  }
  const entries: Array<readonly [string, ToolVerdict]> = [];
  for (const block of content) {
    if (block.type === 'tool_use') {
      entries.push([block.id, verdict]);
    }
  }
  const tool_uses = Object.fromEntries(entries);
  return [{ type: 'dangerous_tool_use', status: { type: 'available', tool_uses } }];
}

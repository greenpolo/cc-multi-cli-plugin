import type { AgentInfo, Register } from 'claude-code';
import { atom, read } from 'claude-code';
import { brandOfType, workerModel } from './brand.ts';
import { isHarnessModel, isProviderWorker, PROVIDERS } from './provider.ts';

// State values are named where they are read: the engine's scan reads an atom's plugin and key
// from this file's own source, not across an import.
const agentModels = atom(
  { plugin: 'multi-core', key: 'agentModels' } as const,
  {} as Record<string, string>,
);
const spawnModels = atom(
  { plugin: 'multi-core', key: 'spawnModels' } as const,
  {} as Record<string, string>,
);
const workerSteps = atom(
  { plugin: 'multi-core', key: 'workerSteps' } as const,
  {} as Record<string, string>,
);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The Agent result's own `resolvedModel`: what a row carries after a reload or resume. */
function resultModel(output: unknown): unknown {
  return record(output)?.resolvedModel;
}

/** The CLI's name for a provider worker's Agent input, else undefined. */
function workerName(input: Record<string, unknown> | undefined, model: unknown) {
  if (!input || !isProviderWorker(input.subagent_type)) {
    return undefined;
  }
  return (workerModel(model)?.brand ?? brandOfType(input.subagent_type))?.name;
}

/** The name the agent list shows for an agent: its CLI for a provider worker, else its type. */
function listName(agent: Pick<AgentInfo, 'type' | 'model'>): string {
  return (workerModel(agent.model)?.brand ?? brandOfType(agent.type))?.name ?? agent.type;
}

/** `950`, `6.8k`, `12.3k`, `1.2M`, as the agent list counts tokens. */
function tokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(Math.max(0, Math.round(count)));
}

/** `16s`, `1m 4s`, as the transcript formats a duration. */
function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * A provider worker's row in the agent list, in the engine's own columns: the name
 * column (padded as the engine pads it to the longest name), the task with the run's
 * newest action beside it, and the time and tokens at the right edge. A harness run
 * answers its one request only when it ends, so its token count would sit still: it
 * shows the time alone.
 */
function listBody(
  agent: AgentInfo & { columns?: number },
  row: { name: string; nameWidth: number; step?: string; isHarness: boolean; now: number },
): string {
  const name = row.name.padEnd(row.nameWidth);
  const step = row.step ? `  ${row.step}` : '';
  const counted = !row.isHarness && agent.tokenCount > 0;
  const right = [
    duration(row.now - agent.startTime),
    ...(counted ? [`↓ ${tokens(agent.tokenCount)} tokens`] : []),
  ].join(' · ');
  const left = `${name}${agent.description}${step}`;
  const gap = Math.max(2, (agent.columns ?? 0) - left.length - right.length);
  return `${left}${' '.repeat(gap)}${right}`;
}

/**
 * Keeps Claude Code's look. A worker's type is its CLI's name (`OpenAI`), which the
 * engine shows wherever it names an agent; these hooks fill the two places it would
 * not: the compact Agent row (`OpenAI(Fix tests · gpt-6-luna)`, which the engine draws
 * as a bare `Agent` for an input naming a provider model), and the agent list, which
 * also shows the run's newest action beside the task. While a
 * CLI is the main model, the spinner names it and its action. The stored input and
 * messages stay as they were.
 */
export const register = (on: Parameters<Register>[0]) => {
  on('ui.render', { component: 'ToolUse' }, async ($, event, next) => {
    const input = record(event.props.input);
    if (event.props.tool !== 'Agent' || !input) {
      return next(event);
    }
    // Read from state while drawing: a spawn that resolves its model redraws the row.
    const model =
      (await read($, spawnModels))[event.props.tool_use_id] ?? resultModel(event.props.output);
    const name = workerName(input, model);
    if (!name) {
      return next(event);
    }
    // Only the row's words change: the engine still draws the row. The call's provider
    // model is not one of the Agent schema's Claude aliases, and the engine draws an
    // input its schema rejects as a bare `Agent`, so the description carries it.
    const { model: _named, ...drawn } = input;
    const id = workerModel(model)?.model;
    const description = typeof input.description === 'string' ? input.description : '';
    const shown = id && description ? `${description} · ${id}` : description;
    return next({
      ...event,
      props: { ...event.props, tool: name, input: { ...drawn, description: shown } },
    });
  });
  on('ui.render', { component: 'AgentRow' }, async ($, event, next) => {
    const agent = event.props;
    const model = agent.model ?? (await read($, agentModels))[agent.id];
    const worker = workerModel(model);
    const brand = worker?.brand ?? brandOfType(agent.type);
    if (!brand || agent.isHidden || agent.body !== undefined) {
      // A Claude agent, a row the person hid, or one their settings already draw.
      return next(event);
    }
    const listed = (await $.agent.list()).filter((other) => other.hasRow);
    const nameWidth =
      Math.max(brand.name.length, ...listed.map((other) => listName(other).length)) + 2;
    const running = agent.taskStatus === 'running';
    const body = listBody(agent, {
      name: brand.name,
      nameWidth,
      step: running ? (await read($, workerSteps))[agent.id] : undefined,
      isHarness:
        typeof model === 'string' ? isHarnessModel(model) : PROVIDERS[brand.key]?.harness === true,
      now: await $.clock.now(),
    });
    return next({ ...event, props: { ...agent, body } });
  });
  on('ui.render', { component: 'Spinner' }, async ($, event, next) => {
    const worker = workerModel((await read($, agentModels)).main);
    if (!worker || event.props.message !== null) {
      return next(event);
    }
    // The CLI and its current step stand in for the sampled word; the engine keeps
    // the elapsed time, tokens and the interrupt hint.
    const step = (await read($, workerSteps)).main;
    const word = step ? `${worker.brand.name} · ${step}` : worker.brand.name;
    return next({ ...event, props: { ...event.props, word } });
  });
};

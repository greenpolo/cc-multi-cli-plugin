import type { Register } from 'claude-code';
import { atom, read } from 'claude-code';
import { isProviderWorker } from '../src/gateway/provider-workers.ts';
import { brandOfType, stepText, workerModel } from './brand.ts';

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

/** `<provider> · <model>` for a Multi model (`multi/cursor/composer-2.5`), else undefined. */
export function workerLabel(model: unknown): string | undefined {
  const worker = workerModel(model);
  return worker ? `${worker.brand.name} · ${worker.model}` : undefined;
}

/** Append label to description, replacing a prior provider-only suffix if present. */
export function appendLabel(description: string, label: string): string {
  if (!description || description.endsWith(label)) {
    return description;
  }
  const [, provider = ''] = /^([A-Za-z]+)\s+·\s+/.exec(label) ?? [];
  const suffix = provider ? ` · ${provider}` : '';
  const base =
    suffix && description.endsWith(suffix) ? description.slice(0, -suffix.length) : description;
  return `${base} · ${label}`;
}

/** The description without the `· <provider> · <model>` label a spawn gave it. */
function bareDescription(description: string, label: string | undefined): string {
  const suffix = label ? ` · ${label}` : '';
  return suffix && description.endsWith(suffix)
    ? description.slice(0, -suffix.length)
    : description;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The Agent result's own `resolvedModel`: what a row carries after a reload or resume. */
function resultModel(output: unknown): unknown {
  return record(output)?.resolvedModel;
}

/** `<description> · <provider> · <model>`: the task's own label, set at spawn. */
export function labelled(description: string, model: string): string {
  const label = workerLabel(model);
  return label ? appendLabel(description, label) : description;
}

/**
 * The Agent row's name and input for a provider worker. Compact, only the label changes
 * (`Cursor(Fix tests · composer-2.5)`); the engine still draws the row and its
 * arguments. ctrl+o keeps the full `Agent` row, labelled. The call's provider model is
 * not one of the Agent schema's Claude aliases, and the engine draws an input its schema
 * rejects as a bare `Agent`, so the words carry it.
 */
function agentRowWords(
  input: Record<string, unknown>,
  model: unknown,
  isExpanded: boolean,
): { tool?: string; input: Record<string, unknown> } {
  const worker = workerModel(model);
  const brand = worker?.brand ?? brandOfType(input.subagent_type);
  const label = workerLabel(model);
  const description = typeof input.description === 'string' ? input.description : '';
  const { model: _named, ...drawn } = input;
  if (brand && !isExpanded) {
    const bare = bareDescription(description, label);
    const shown = worker && bare ? `${bare} · ${worker.model}` : bare;
    return { tool: brand.name, input: { ...drawn, description: shown } };
  }
  const shown = label && description ? appendLabel(description, label) : input.description;
  return { input: { ...drawn, description: shown } };
}

/**
 * Keeps Claude Code's own rows and changes only their words, so a Multi worker looks
 * like any Claude agent: the Agent row is named for its CLI (`Cursor(Fix tests ·
 * composer-2.5)`, where a Claude agent reads `Agent(Fix tests)`), the agent list shows
 * the run's newest action where it shows a Claude agent's progress, and the spinner
 * names the CLI and its action while it is the main model. A background agent's
 * notification gains `<provider> · <model>`. The stored input and messages stay as
 * they were.
 */
export const register = (on: Parameters<Register>[0]) => {
  on('ui.render', { component: 'ToolUse' }, async ($, event, next) => {
    const input = record(event.props.input);
    if (event.props.tool !== 'Agent' || !input || !isProviderWorker(input.subagent_type)) {
      return next(event);
    }
    // Read from state while drawing: a spawn that resolves its model redraws the row.
    const model =
      (await read($, spawnModels))[event.props.tool_use_id] ?? resultModel(event.props.output);
    const drawn = agentRowWords(input, model, event.props.isExpanded === true);
    return next({ ...event, props: { ...event.props, ...drawn } });
  });
  on('ui.render', { component: 'AgentRow' }, async ($, event, next) => {
    const props = event.props;
    const step = stepText((await read($, workerSteps))[props.id]);
    if (!step || props.taskStatus !== 'running') {
      return next(event);
    }
    // The engine's own row, its progress words replaced by the harness's newest action.
    return next({ ...event, props: { ...props, label: step } });
  });
  on('ui.render', { component: 'Spinner' }, async ($, event, next) => {
    const worker = workerModel((await read($, agentModels)).main);
    if (!worker || event.props.message !== null) {
      return next(event);
    }
    // The CLI and its current step stand in for the sampled word; the engine keeps
    // the elapsed time, tokens and the interrupt hint.
    const step = stepText((await read($, workerSteps)).main);
    const word = step ? `${worker.brand.name} · ${step}` : worker.brand.name;
    return next({ ...event, props: { ...event.props, word } });
  });
  on(
    'ui.render',
    { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } },
    async ($, event, next) => {
      if (event.component !== 'UserMessage' || event.props.isExpanded) {
        return next(event);
      }
      const task = event.props.task;
      const agents = await read($, agentModels);
      const spawns = await read($, spawnModels);
      const label = workerLabel(
        (task?.id ? agents[task.id] : undefined) ??
          (task?.toolUseId ? spawns[task.toolUseId] : undefined),
      );
      // A spawn's labelled description already names it in the notification's summary.
      if (!label || event.props.text.includes(label)) {
        return next(event);
      }
      return next({ ...event, props: { ...event.props, text: `${event.props.text} · ${label}` } });
    },
  );
};

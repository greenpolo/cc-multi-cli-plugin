import type { Register } from 'claude-code';
import { atom, read } from 'claude-code';
import { isProviderWorker } from '../src/gateway/provider-workers.ts';
import { type Brand, brandOfType, nameWidth, stepText, workerModel } from './brand.ts';
import { headerDot, listRow, workerHeader } from './worker-view.ts';

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

/** What the agent list says a worker is doing, or how it ended. */
function listState(
  props: { taskStatus: string; status: string; label: string; description: string },
  step: string | undefined,
): { text: string; color?: string } {
  if (props.taskStatus === 'completed') {
    return { text: 'done', color: 'success' };
  }
  if (props.taskStatus === 'failed' || props.status === 'failed') {
    return { text: 'failed', color: 'error' };
  }
  if (props.taskStatus === 'killed' || props.status === 'killed') {
    return { text: 'stopped' };
  }
  const summary = props.label !== props.description ? props.label : '';
  return { text: stepText(step || summary) || 'working' };
}

/**
 * Marks each Multi worker as its CLI, in Claude Code's own shapes; the engine still
 * draws every row of a Claude agent, and the stored input and messages stay as they
 * were. The Agent row's header leads with the CLI's name in its colour and the model
 * beside it; the agent list under the prompt gives each worker a coloured column, its
 * current step, a token trend line and its elapsed time; a background agent's
 * notification gains `<provider> · <model>`.
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
    const worker = workerModel(model);
    const brand: Brand | undefined = worker?.brand ?? brandOfType(input.subagent_type);
    const label = workerLabel(model);
    const description = typeof input.description === 'string' ? input.description : '';
    if (brand && !event.props.isExpanded) {
      return workerHeader($.ui.resolve(event), {
        brand,
        model: worker?.model,
        description: bareDescription(description, label),
        dot: headerDot(event.props, brand),
      });
    }
    // ctrl+o keeps the engine's full row. The call's provider model is not one of the
    // Agent schema's Claude aliases, and the engine draws an input its schema rejects as
    // a bare `Agent`: the label in the description carries it.
    const { model: _named, ...drawn } = input;
    const shown = label && description ? appendLabel(description, label) : input.description;
    return next({
      ...event,
      props: { ...event.props, input: { ...drawn, description: shown } },
    });
  });
  on('ui.render', { component: 'AgentRow' }, async ($, event, next) => {
    const props = event.props;
    const model = props.model ?? (await read($, agentModels))[props.id];
    const worker = workerModel(model);
    const brand = worker?.brand ?? brandOfType(props.type);
    if (!brand || props.isHidden || props.body !== undefined) {
      // A Claude agent, a row the person hid, or one their settings already draw.
      return next(event);
    }
    const step = (await read($, workerSteps))[props.id];
    return listRow($.ui.resolve(event), {
      brand,
      nameWidth,
      description: bareDescription(props.description, workerLabel(model)),
      state: listState(props, step),
      tokenCount: props.tokenCount,
      tokenSamples: props.tokenSamples,
      elapsedMs: (await $.clock.now()) - props.startTime,
      columns: props.columns,
    });
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

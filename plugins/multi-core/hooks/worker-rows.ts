import type { Register } from 'claude-code';

/**
 * The provider worker types. Each runs one provider's models, and its Agent call's
 * `model` picks which; the rows below keep that model in sight wherever the agent shows.
 */
const PROVIDER_WORKERS = new Set([
  'multi-openai',
  'multi-zen',
  'multi-cursor',
  'multi-antigravity',
  'multi-grok',
]);

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openai: 'OpenAI',
  zen: 'Zen',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  grok: 'Grok',
};

export function isProviderWorker(type: unknown): boolean {
  return typeof type === 'string' && PROVIDER_WORKERS.has(type);
}

/** Provider display name for a `multi-*` subagent type, else undefined. */
export function providerName(subagentType: unknown): string | undefined {
  if (typeof subagentType !== 'string') {
    return undefined;
  }
  const [, key = ''] = /^multi-([a-z]+)$/.exec(subagentType) ?? [];
  return Object.hasOwn(PROVIDER_LABELS, key) ? PROVIDER_LABELS[key] : undefined;
}

/** `<provider> · <model>` for a Multi model (`multi/cursor/composer-2.5`), else undefined. */
export function workerLabel(model: unknown): string | undefined {
  if (typeof model !== 'string') {
    return undefined;
  }
  const [, name = '', spelled = ''] = /^multi\/([a-z]+)\/(.+)$/.exec(model) ?? [];
  const provider = Object.hasOwn(PROVIDER_LABELS, name) ? PROVIDER_LABELS[name] : undefined;
  if (!provider || !spelled) {
    return undefined;
  }
  const raw = spelled.replace(/\[1m\]$/i, '');
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // An undecodable id is shown as spelled.
  }
  return `${provider} · ${id}`;
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
 * Labels only: the engine still draws every row. The Agent row (running, and its
 * completion) and a background agent's notification gain `<provider> · <model>`
 * beside their description; the stored input and message stay as they were.
 */
export const register = (
  on: Parameters<Register>[0],
  agentModels: ReadonlyMap<string, string>,
  spawnModels: ReadonlyMap<string, string>,
) => {
  on('ui.render', { component: 'ToolUse' }, async (_$, event, next) => {
    const input = record(event.props.input);
    if (event.props.tool !== 'Agent' || !input || !isProviderWorker(input.subagent_type)) {
      return next(event);
    }
    const label = workerLabel(
      spawnModels.get(event.props.tool_use_id) ?? resultModel(event.props.output),
    );
    // The call's provider model is not one of the Agent schema's Claude aliases, and the
    // engine draws an input its schema rejects as a bare `Agent`: the label carries it.
    const { model: _named, ...drawn } = input;
    const description =
      label && typeof input.description === 'string'
        ? appendLabel(input.description, label)
        : input.description;
    return next({ ...event, props: { ...event.props, input: { ...drawn, description } } });
  });
  on(
    'ui.render',
    { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } },
    async (_$, event, next) => {
      if (event.component !== 'UserMessage' || event.props.isExpanded) {
        return next(event);
      }
      const task = event.props.task;
      const label = workerLabel(
        (task?.id ? agentModels.get(task.id) : undefined) ??
          (task?.toolUseId ? spawnModels.get(task.toolUseId) : undefined),
      );
      // A spawn's labelled description already names it in the notification's summary.
      if (!label || event.props.text.includes(label)) {
        return next(event);
      }
      return next({ ...event, props: { ...event.props, text: `${event.props.text} · ${label}` } });
    },
  );
};

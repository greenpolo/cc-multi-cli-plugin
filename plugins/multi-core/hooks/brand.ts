// Each CLI's name and colour, shared by every surface that marks a Multi worker: the
// Agent row, the agent list, the spinner and the status line. Colours are raw hex,
// mid-tone so they read on light and dark terminals alike.

export type Brand = { key: string; name: string; color: string };

const BRANDS: Readonly<Record<string, Brand>> = {
  openai: { key: 'openai', name: 'OpenAI', color: '#3fb68b' },
  zen: { key: 'zen', name: 'Zen', color: '#36b9c9' },
  cursor: { key: 'cursor', name: 'Cursor', color: '#5b9bf8' },
  antigravity: { key: 'antigravity', name: 'Antigravity', color: '#a77bf3' },
  grok: { key: 'grok', name: 'Grok', color: '#f08a4b' },
};

/** The longest CLI name, so rows that pad to it line up whichever CLIs run. */
export const nameWidth = Math.max(...Object.values(BRANDS).map((brand) => brand.name.length));

/** The brand of a provider key (`cursor`), else undefined. */
export function brandOf(provider: unknown): Brand | undefined {
  return typeof provider === 'string' && Object.hasOwn(BRANDS, provider)
    ? BRANDS[provider]
    : undefined;
}

/** The brand of a `multi-*` subagent type, else undefined. */
export function brandOfType(subagentType: unknown): Brand | undefined {
  if (typeof subagentType !== 'string') {
    return undefined;
  }
  const [, key = ''] = /^multi-([a-z]+)$/.exec(subagentType) ?? [];
  return brandOf(key);
}

export type WorkerModel = { brand: Brand; model: string };

/** The brand and model id of a Multi model (`multi/cursor/composer-2.5`), else undefined. */
export function workerModel(model: unknown): WorkerModel | undefined {
  if (typeof model !== 'string') {
    return undefined;
  }
  const [, key = '', spelled = ''] = /^multi\/([a-z]+)\/(.+)$/.exec(model) ?? [];
  const brand = brandOf(key);
  if (!brand || !spelled) {
    return undefined;
  }
  const raw = spelled.replace(/\[1m\]$/i, '');
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // An undecodable id is shown as spelled.
  }
  return { brand, model: id };
}

/** `<provider> <model>` for a Multi model, else undefined: the status line's name. */
export function workerName(model: unknown): string | undefined {
  const worker = workerModel(model);
  return worker ? `${worker.brand.name} ${worker.model}` : undefined;
}

/** A harness action's own words on one line, without a trailing period. */
export function stepText(detail: unknown, maximum = 60): string {
  if (typeof detail !== 'string') {
    return '';
  }
  const line = detail.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line;
}

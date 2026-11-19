// Each CLI's display name, shared by every surface that names a Multi worker: the
// Agent row, the spinner and the status line.

import { WORKER_TYPES } from '../src/gateway/provider-workers.ts';

type Brand = { key: string; name: string };

const BRANDS: Readonly<Record<string, Brand>> = {
  openai: { key: 'openai', name: 'OpenAI' },
  zen: { key: 'zen', name: 'Zen' },
  cursor: { key: 'cursor', name: 'Cursor' },
  antigravity: { key: 'antigravity', name: 'Antigravity' },
  grok: { key: 'grok', name: 'Grok' },
};

/** The brand of a provider key (`cursor`), else undefined. */
export function brandOf(provider: unknown): Brand | undefined {
  return typeof provider === 'string' && Object.hasOwn(BRANDS, provider)
    ? BRANDS[provider]
    : undefined;
}

/** The brand of a provider worker type (`Cursor`, or a legacy `multi-cursor`), else undefined. */
export function brandOfType(subagentType: unknown): Brand | undefined {
  const [provider] =
    Object.entries(WORKER_TYPES).find(
      ([key, type]) => subagentType === type || subagentType === `multi-${key}`,
    ) ?? [];
  return brandOf(provider);
}

type WorkerModel = { brand: Brand; model: string };

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

const absolutePath = /(?:[A-Za-z]:[\\/]|\/)[^\s'"`]*/g;

/** `path` relative to `cwd` when it lies inside it, else its last two segments. */
function shortPath(path: string, cwd: string): string {
  const slashes = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const target = slashes(path);
  const base = slashes(cwd);
  // Windows paths compare without case, as the file system does.
  const fold = /^[A-Za-z]:/.test(target) ? (value: string) => value.toLowerCase() : String;
  if (base && fold(target).startsWith(`${fold(base)}/`)) {
    return target.slice(base.length + 1);
  }
  const parts = target.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : target;
}

/** A harness action's words with every absolute path made short, on one line. */
export function shortStep(detail: unknown, cwd: string): string {
  return stepText(
    typeof detail === 'string' ? detail.replace(absolutePath, (path) => shortPath(path, cwd)) : '',
  );
}

import type { ElementTable, RenderElement } from 'claude-code';
import type { Brand } from './brand.ts';

/**
 * The drawings that mark a Multi worker as its CLI, in Claude Code's own shapes: the
 * Agent row's header (`● Cursor composer-2.5  Fix tests`, where Claude draws
 * `● Agent(Fix tests)`) and a row of the agent list under the prompt.
 */
type Tags = Pick<ElementTable, 'Box' | 'Text'>;

const bars = '▁▂▃▄▅▆▇█';
const sparkSamples = 8;
/** The columns below which the list row drops its token trend line. */
const sparkColumns = 72;
const descriptionLength = 48;
const stepLength = 40;

/** `● <provider> <model>  <description>`: the Agent row's header for a Multi worker. */
export function workerHeader(
  { Box, Text }: Tags,
  row: { brand: Brand; model?: string; description: string; dot: string },
): RenderElement {
  return Box({
    flexDirection: 'row',
    children: [
      Box({ minWidth: 2, children: Text({ color: row.dot, children: '●' }) }),
      Text({ bold: true, color: row.brand.color, children: row.brand.name }),
      ...(row.model ? [Text({ dimColor: true, children: ` ${row.model}` })] : []),
      ...(row.description ? [Text({ children: `  ${row.description}` })] : []),
    ],
  });
}

/** The header's dot: the CLI's colour while it works, then the engine's own outcome colours. */
export function headerDot(
  props: { isRunning: boolean; isErrored: boolean; isInterrupted: boolean },
  brand: Brand,
): string {
  if (props.isErrored) {
    return 'error';
  }
  if (props.isInterrupted) {
    return 'inactive';
  }
  return props.isRunning ? brand.color : 'success';
}

export type ListRow = {
  brand: Brand;
  /** The width every provider name is padded to, so the list's columns line up. */
  nameWidth: number;
  description: string;
  /** What it is doing now, or how it ended. */
  state: { text: string; color?: string };
  tokenCount: number;
  tokenSamples: readonly number[];
  elapsedMs: number;
  columns?: number;
};

/** `▌Cursor  Fix tests  edit: a.ts  ▁▂▃▅▇ 41k 1m12s`: one worker in the agent list. */
export function listRow({ Box, Text }: Tags, row: ListRow): RenderElement {
  const showSpark = (row.columns ?? sparkColumns) >= sparkColumns;
  const spark = showSpark ? sparkline(row.tokenSamples) : '';
  const figures = [row.tokenCount > 0 ? compactTokens(row.tokenCount) : '', duration(row.elapsedMs)]
    .filter(Boolean)
    .join(' ');
  return Box({
    flexDirection: 'row',
    children: [
      Text({ color: row.brand.color, children: `▌${row.brand.name.padEnd(row.nameWidth)} ` }),
      Text({ children: clip(row.description, descriptionLength) }),
      Text({
        ...(row.state.color ? { color: row.state.color } : { dimColor: true }),
        children: `  ${clip(row.state.text, stepLength)}`,
      }),
      ...(spark ? [Text({ color: row.brand.color, children: `  ${spark}` })] : []),
      ...(figures ? [Text({ dimColor: true, children: `  ${figures}` })] : []),
    ],
  });
}

/** The last readings as bars scaled between their own least and most; empty for fewer than two. */
export function sparkline(samples: readonly number[]): string {
  const shown = samples.slice(-sparkSamples).filter((value) => Number.isFinite(value));
  if (shown.length < 2) {
    return '';
  }
  const low = Math.min(...shown);
  const high = Math.max(...shown);
  if (high <= 0) {
    return '';
  }
  const span = high - low;
  return shown
    .map((value) => bars[span === 0 ? 0 : Math.round(((value - low) / span) * (bars.length - 1))])
    .join('');
}

/** `950`, `41k`, `1.2M`. */
export function compactTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1000) {
    return `${Math.round(count / 1000)}k`;
  }
  return String(Math.max(0, Math.round(count)));
}

/** `48s`, `1m12s`, `1h03m`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function clip(text: string, maximum: number): string {
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

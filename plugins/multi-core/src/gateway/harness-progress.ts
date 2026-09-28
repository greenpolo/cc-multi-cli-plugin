import type { DerivedMirror, DisplayToolUse, NativeRow } from './display-rows.ts';
import { displayLine } from './mod-bridge.ts';

export type NativeActionKind = 'read' | 'search' | 'edit' | 'shell' | 'other';
/**
 * A provider-reported native action. `toolset` names the tools a harness
 * announced; `started` and `completed` bracket one action. A completion carries
 * the native tool, its parameters and its output, from which the gateway may
 * issue a display row; nothing here can execute or replay the action.
 */
export type NativeObservation =
  | { type: 'toolset'; tools: readonly string[] }
  | { type: 'started'; id: string; kind: NativeActionKind; tool: string; description: string }
  | {
      type: 'completed';
      id: string;
      kind: NativeActionKind;
      outcome: string;
      error: boolean;
      /** The run ended before this action reported a completion: neither done nor failed. */
      unconfirmed?: boolean;
      row: NativeRow;
    };
/** Returns the display row the gateway issued for a completion, if any. */
export type NativeProgressObserver = (observation: NativeObservation) => DisplayToolUse | undefined;

/** A started native action: its kind, the native tool name and its native parameters. */
export type NativeAction = {
  kind: NativeActionKind;
  tool: string;
  input: unknown;
  description: string;
  /** What a successful edit touched, for the transcript summary. */
  changed?: string;
};

const maximumListed = 8;
const maximumTracked = 512;
const unsettledOutput = "The native run ended without reporting this action's completion.";

/**
 * The one terse record a native run leaves in the transcript, so a later model
 * (a provider switch, or the parent of a worker) knows what changed and what
 * failed. Each action is also a display row in the same reply.
 */
export class NativeActionSummary {
  private readonly counts = new Map<NativeActionKind, number>();
  private readonly changed = new Set<string>();
  private readonly problems: string[] = [];
  private unconfirmed = 0;
  private readonly tag: string;

  constructor(tag: string) {
    this.tag = tag;
  }

  /**
   * Counts one finished action; `changed` names what a successful edit touched.
   * An unconfirmed action is counted but never listed as a change.
   */
  record(
    kind: NativeActionKind,
    result: { error: boolean; unconfirmed?: boolean; label: string; changed?: string },
  ) {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    if (result.unconfirmed && !result.error) {
      this.unconfirmed++;
      return;
    }
    if (result.error) {
      if (this.problems.length < maximumListed) {
        this.problems.push(displayLine(result.label));
      }
      return;
    }
    if (kind === 'edit' && result.changed && this.changed.size < maximumListed) {
      this.changed.add(displayLine(result.changed));
    }
  }

  /** `modelCalls` is how many model calls the run made, when the harness reported them. */
  text(modelCalls = 0): string {
    const total = [...this.counts.values()].reduce((sum, count) => sum + count, 0);
    if (!total && modelCalls < 2) {
      return '';
    }
    const calls = modelCalls ? `${modelCalls} model call${modelCalls === 1 ? '' : 's'}` : '';
    const parts = [...this.counts].map(([kind, count]) => `${count} ${kind}`);
    const actions = total
      ? `${total} native action${total === 1 ? '' : 's'}: ${parts.join(', ')}`
      : '';
    const lines = [`[${this.tag}] ${[actions, calls].filter(Boolean).join('; ')}.`];
    if (this.changed.size) {
      lines.push(`[${this.tag}] Changed: ${[...this.changed].join(', ')}.`);
    }
    if (this.problems.length) {
      lines.push(`[${this.tag}] Not completed: ${this.problems.join('; ')}.`);
    }
    if (this.unconfirmed) {
      const count = `${this.unconfirmed} action${this.unconfirmed === 1 ? '' : 's'}`;
      lines.push(`[${this.tag}] Unconfirmed: ${count} ended without a reported outcome.`);
    }
    return `\n\n${lines.join('\n')}\n`;
  }
}

type Tracked = NativeAction & { done: boolean };

/**
 * Pairs a harness's native action starts and completions. Each completion is
 * reported to the gateway's observer, and a display row the gateway issues for
 * it goes to `row`, the reply being written. The transcript summary is kept too.
 * Actions are observations only: nothing here can execute or replay them.
 */
export class NativeActionTracker {
  private readonly actions = new Map<string, Tracked>();
  private readonly summary: NativeActionSummary;
  private readonly observe: NativeProgressObserver | undefined;
  private readonly row: ((block: DisplayToolUse) => void) | undefined;

  constructor(
    tag: string,
    observe?: NativeProgressObserver,
    row?: (block: DisplayToolUse) => void,
  ) {
    this.summary = new NativeActionSummary(tag);
    this.observe = observe;
    this.row = row;
  }

  has(id: string) {
    return this.actions.has(id);
  }

  /** Reports the tools a harness announced, so the mod can register their rows. */
  toolset(tools: readonly string[]) {
    this.observe?.({ type: 'toolset', tools });
  }

  /** Reports a new action once; a repeated start for the same id is ignored. */
  start(id: string, action: NativeAction) {
    if (this.actions.has(id) || this.actions.size >= maximumTracked) {
      return;
    }
    const description = displayLine(action.description) || action.tool || action.kind;
    this.actions.set(id, { ...action, description, done: false });
    this.observe?.({ type: 'started', id, kind: action.kind, tool: action.tool, description });
  }

  /**
   * Settles a started action once. `outcome` is one line for the summary and the
   * status line; `output` is the native output the row shows (the outcome when absent);
   * `mirror` holds row fields derived from the result (see `DerivedMirror`).
   */
  finish(
    id: string,
    result: {
      outcome: string;
      output?: string;
      error: boolean;
      unconfirmed?: boolean;
      mirror?: DerivedMirror;
    },
  ) {
    const action = this.actions.get(id);
    if (!action || action.done) {
      return;
    }
    action.done = true;
    const outcome = displayLine(result.outcome) || (result.error ? 'failed' : 'done');
    const unconfirmed = result.unconfirmed === true && !result.error;
    const block = this.observe?.({
      type: 'completed',
      id,
      kind: action.kind,
      outcome,
      error: result.error,
      ...(unconfirmed ? { unconfirmed } : {}),
      row: {
        tool: action.tool,
        input: action.input,
        output: result.output ?? outcome,
        error: result.error,
        ...(unconfirmed ? { unconfirmed } : {}),
        ...(result.mirror ? { mirror: result.mirror } : {}),
      },
    });
    if (block) {
      this.row?.(block);
    }
    this.summary.record(action.kind, {
      error: result.error,
      unconfirmed,
      label: `${action.description} (${outcome})`,
      changed: action.changed,
    });
  }

  /**
   * Settles every action whose completion never arrived. The run ended, so none
   * is left running: each is reported unconfirmed, neither done nor failed.
   */
  settle() {
    for (const [id, action] of this.actions) {
      if (!action.done) {
        this.finish(id, {
          outcome: 'ended without a reported outcome',
          output: unsettledOutput,
          error: false,
          unconfirmed: true,
        });
      }
    }
  }

  /**
   * The transcript summary, after every unfinished action was settled, with the
   * run's model call count when the harness reported one.
   */
  text(modelCalls?: number): string {
    this.settle();
    return this.summary.text(modelCalls);
  }
}

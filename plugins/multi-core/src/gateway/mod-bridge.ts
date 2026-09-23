import type { NativeObservation } from './harness-progress.ts';

const MAX_LINE = 160;
const MAX_ERROR = 240;
const MAX_KEYS = 128;

type Effective = {
  permissionMode?: string;
  tools?: string[];
  disallowedTools?: string[];
};

type Snapshot = {
  generation: number;
  effective: Effective;
  cwd?: string;
};

type Lifecycle = {
  model: string;
  startedAt: number;
  state: string;
  detail: string;
  run: number;
  attached: number;
  error?: string;
};

const escapeCharacter = String.fromCharCode(27);
const bell = String.fromCharCode(7);
const terminalSequence = new RegExp(
  `${escapeCharacter}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${escapeCharacter}${bell}]*(?:${bell}|${escapeCharacter}\\\\))`,
  'g',
);

/**
 * One terminal-safe line: escape sequences, control and format characters are
 * removed and whitespace collapsed, so provider or gateway text cannot restyle
 * or break the Claude Code surface that shows it.
 */
export function displayLine(value: string, limit = MAX_LINE) {
  return value
    .replaceAll(terminalSequence, '')
    .replaceAll(/[\p{Cc}]/gu, ' ')
    .replaceAll(/[\p{Cf}]/gu, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export class ModBridge {
  private generation = 0;
  private readonly snapshots = new Map<string, Snapshot>();
  private run = 0;
  private readonly lifecycle = new Map<string, Lifecycle>();
  private readonly telemetry = new Map<string, { model: string; effort?: string | number }>();

  recordSession(key: string, value: { effective: Effective; cwd?: string; generation?: number }) {
    return this.record(key, value);
  }

  mode(key: string) {
    return this.snapshots.get(key);
  }

  private record(key: string, value: { effective: Effective; cwd?: string; generation?: number }) {
    if (
      value.generation !== undefined &&
      value.generation !== this.snapshots.get(key)?.generation
    ) {
      return undefined;
    }
    if (!this.snapshots.has(key) && this.snapshots.size >= MAX_KEYS) {
      throw new Error('Mod session capacity reached; restart the gateway');
    }
    const snapshot = {
      generation: ++this.generation,
      effective: {
        permissionMode: value.effective.permissionMode,
        tools: value.effective.tools?.slice(0, 256),
        disallowedTools: value.effective.disallowedTools?.slice(0, 256),
      },
      cwd: value.cwd,
    };
    this.snapshots.set(key, snapshot);
    return snapshot;
  }

  /**
   * Keeps the newest action of the run `begin` returned as its status detail; an
   * observation from a superseded or finished run is dropped. Nothing is replayed.
   */
  observe(key: string, generation: number, observation: NativeObservation): void {
    const run = this.lifecycle.get(key);
    if (!run || run.run !== generation || run.state !== 'running') {
      return;
    }
    if (observation.type === 'started') {
      run.detail = displayLine(observation.description);
    }
  }

  /**
   * Starts a run for the scope, or attaches to the one still running there: a
   * harness runs one native exchange per identity, so an identical retry observes
   * that run and a conflicting request is refused without disturbing its actions.
   */
  begin(key: string, model: string): number {
    const current = this.lifecycle.get(key);
    if (current?.state === 'running') {
      current.attached++;
      return current.run;
    }
    if (!current && !this.makeRoom()) {
      throw new Error('Native lifecycle capacity reached; restart the gateway');
    }
    this.lifecycle.set(key, {
      model,
      startedAt: Date.now(),
      state: 'running',
      detail: '',
      run: ++this.run,
      attached: 1,
    });
    return this.run;
  }

  /**
   * Records a harness request the gateway refused before any native run began
   * (policy admission, an unavailable provider, an invalid request), so the
   * status line and the refused request can say why instead of a bare failure. A run that
   * is still running in the scope is never replaced.
   */
  refuse(key: string, model: string, error: string) {
    const current = this.lifecycle.get(key);
    if (current?.state === 'running' || (!current && !this.makeRoom())) {
      return;
    }
    this.lifecycle.set(key, {
      model,
      startedAt: Date.now(),
      state: 'failed',
      detail: '',
      run: ++this.run,
      attached: 0,
      error: displayLine(error, MAX_ERROR) || 'Request refused',
    });
  }

  private makeRoom() {
    if (this.lifecycle.size < MAX_KEYS) {
      return true;
    }
    const completed = [...this.lifecycle].find(([, value]) => value.state !== 'running');
    if (!completed) {
      return false;
    }
    this.lifecycle.delete(completed[0]);
    return true;
  }

  status(key: string) {
    const value = this.lifecycle.get(key);
    if (!value) {
      return undefined;
    }
    return {
      model: value.model,
      startedAt: value.startedAt,
      state: value.state,
      detail: value.detail,
      ...(value.error ? { error: value.error } : {}),
      elapsedMs: Date.now() - value.startedAt,
    };
  }

  step(key: string) {
    return this.telemetry.get(key);
  }

  observeStep(key: string, value: { model: string; effort?: string | number }) {
    if (!this.telemetry.has(key) && this.telemetry.size >= MAX_KEYS) {
      this.telemetry.delete(this.telemetry.keys().next().value as string);
    }
    this.telemetry.set(key, value);
  }

  /**
   * Ends one attachment. A failed or cancelled request that still shares its run
   * with another observer leaves that run running; success settles it at once.
   * `error` is the reason a failed run ended, kept as one sanitised line.
   */
  complete(key: string, state = 'completed', generation?: number, error?: string) {
    const value = this.lifecycle.get(key);
    if (value?.state !== 'running') {
      return;
    }
    if (generation !== undefined && value.run !== generation) {
      return;
    }
    value.attached = Math.max(0, value.attached - 1);
    if (state !== 'completed' && value.attached > 0) {
      return;
    }
    value.state = state;
    if (state !== 'completed' && error) {
      value.error = displayLine(error, MAX_ERROR);
    }
  }

  forgetSession(session: string) {
    for (const entries of [this.snapshots, this.lifecycle, this.telemetry]) {
      for (const key of entries.keys()) {
        if (JSON.parse(key)[0] === session) {
          entries.delete(key);
        }
      }
    }
  }
}

// Pure normalization helpers for task/review options: model aliases, reasoning
// effort validation, and single-string argv splitting. Extracted from
// multi-cli-companion.mjs so the option-parsing rules can be unit-tested in
// isolation (see test/unit/task-options.test.mjs).

import { splitRawArgumentString } from "./args.mjs";

export const VALID_REASONING_EFFORTS = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"
]);
export const MODEL_ALIASES = new Map();

export function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

export function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: ${[...VALID_REASONING_EFFORTS].join(", ")}.`
    );
  }
  return normalized;
}

// Codex model/effort routing. The judgment call ("is this a written spec or an
// open-ended handoff?") stays with the forwarder subagent, which passes it as
// --task-kind; the kind → model/effort mapping is deterministic and lives here
// so no model has to evaluate a lookup table at dispatch time.
export const TASK_KIND_DEFAULTS = new Map([
  // Rigorous execution of an already-decided shape.
  ["spec", { model: "gpt-5.6-terra", effort: "medium" }],
  // Agentic work with latitude to choose the approach.
  ["open-ended", { model: "gpt-5.6-sol", effort: "medium" }]
]);

/**
 * Apply --task-kind defaults for Codex. Explicit --model/--effort always win;
 * without a kind (or for non-codex CLIs) nothing is defaulted and the upstream
 * CLI's own defaults apply.
 *
 * @returns {{ model: string|null, effort: string|null }}
 */
export function resolveTaskRouting({ cli = "codex", kind = null, model = null, effort = null } = {}) {
  const normalizedKind = kind == null ? null : String(kind).trim().toLowerCase();
  if (!normalizedKind) {
    return { model: model ?? null, effort: effort ?? null };
  }
  const defaults = TASK_KIND_DEFAULTS.get(normalizedKind);
  if (!defaults) {
    throw new Error(
      `Unsupported --task-kind "${kind}". Use one of: ${[...TASK_KIND_DEFAULTS.keys()].join(", ")}.`
    );
  }
  if (cli !== "codex") {
    // Only Codex has these model slugs / an --effort knob.
    return { model: model ?? null, effort: effort ?? null };
  }
  return {
    model: model ?? defaults.model,
    effort: effort ?? defaults.effort
  };
}

export function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

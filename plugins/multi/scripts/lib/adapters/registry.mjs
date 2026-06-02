// Single source of truth for which CLI adapters exist. Imported by the companion
// (to dispatch `--cli`) and by the contract test (so a missed registration or a
// non-conforming adapter fails `npm test` instead of slipping through).

import * as codex from "./codex.mjs";
import * as cursor from "./cursor.mjs";
import * as antigravity from "./antigravity.mjs";
import * as opencode from "./opencode.mjs";

// Keys are CLI names as seen by the user (`--cli <name>`).
export const ADAPTERS = { codex, cursor, antigravity, opencode };

export function getAdapter(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`Unknown CLI: ${name}. Available: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return adapter;
}

export * from "./codex-roles-prompts.mjs";
export * from "./codex-render-parse.mjs";
export * from "./codex-transport.mjs";

import { runAppServerTurn, interruptAppServerTurn } from "./codex-transport.mjs";
import { getCodexAvailability, getCodexAuthStatus } from "./codex-render-parse.mjs";

// ─── Generic adapter interface ────────────────────────────────────────────────
//
// Exposes a standard shape so multi-cli-companion.mjs can dispatch
// uniformly through the ADAPTERS registry. Specific named exports above are
// kept intact so existing companion code continues to work.
//
// Spec members:
//   name           — string identifier
//   isAvailable    — sync: (cwd) => { available, detail }
//   isAuthenticated — async: (cwd) => auth status object
//   invoke         — async: primary turn function (maps to runAppServerTurn)
//   cancel         — async: interrupt an in-flight turn

export const adapter = {
  name: "codex",
  isAvailable: getCodexAvailability,
  isAuthenticated: getCodexAuthStatus,
  invoke: runAppServerTurn,
  cancel: interruptAppServerTurn,
  getSession: undefined
};

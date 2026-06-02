// Pins the adapter contract (see lib/adapters/CONTRACT.md). Offline: importing an
// adapter module only wires function references — it spawns no CLI.

import test from "node:test";
import assert from "node:assert/strict";

// Import the REAL registry the companion uses (not a local copy), so a missed
// registration or a non-conforming adapter fails here.
import {
  ADAPTERS,
  getAdapter,
} from "../../plugins/multi/scripts/lib/adapters/registry.mjs";

const REQUIRED_FNS = ["isAvailable", "isAuthenticated", "invoke", "cancel"];

for (const [key, mod] of Object.entries(ADAPTERS)) {
  test(`adapter "${key}" conforms to the contract`, () => {
    const a = mod.adapter;
    assert.ok(a && typeof a === "object", `${key} must export an 'adapter' object`);
    assert.equal(a.name, key, "adapter.name must equal the registry key");

    for (const fn of REQUIRED_FNS) {
      assert.equal(typeof a[fn], "function", `adapter.${fn} must be a function`);
    }

    assert.ok("getSession" in a, "adapter must declare getSession (function or undefined)");
    assert.ok(
      a.getSession === undefined || typeof a.getSession === "function",
      "adapter.getSession must be a function or undefined",
    );
  });
}

test("registry exposes exactly the four known adapters", () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(), ["antigravity", "codex", "cursor", "opencode"]);
});

test("getAdapter resolves a known CLI and throws a clear error for an unknown one", () => {
  assert.equal(getAdapter("codex"), ADAPTERS.codex);
  assert.throws(() => getAdapter("frobnicate"), /Unknown CLI: frobnicate/);
});

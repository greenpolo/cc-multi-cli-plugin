#!/usr/bin/env node
/**
 * Qwen adapter ACP flag test
 *
 * Verifies that the Qwen adapter constructs its launch command with the
 * stable `--acp` flag and does NOT use the deprecated `--experimental-acp`.
 *
 * Qwen Code v0.15.6 graduated `--acp` from `--experimental-acp` (PR #1355).
 * The deprecated alias still works but emits a warning; the adapter should
 * always pass the stable flag.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Import the Qwen adapter ──────────────────────────────────────────────────

const adapterPath = path.resolve(__dirname, "..", "lib", "adapters", "qwen.mjs");
const { getQwenAvailability, adapter } = await import(adapterPath);

let failures = 0;

function assert(condition, message) {
  if (condition) {
    process.stdout.write(`  PASS: ${message}\n`);
  } else {
    process.stderr.write(`  FAIL: ${message}\n`);
    failures++;
  }
}

// ─── Test 1: adapter name ─────────────────────────────────────────────────────

process.stdout.write("Test 1: adapter metadata\n");
assert(adapter.name === "qwen", `adapter.name is "qwen" (got: ${adapter.name})`);
assert(typeof adapter.isAvailable === "function", "isAvailable is a function");
assert(typeof adapter.isAuthenticated === "function", "isAuthenticated is a function");
assert(typeof adapter.invoke === "function", "invoke is a function");
assert(typeof adapter.cancel === "function", "cancel is a function");

// ─── Test 2: source-code inspection ────────────────────────────────────────────
//
// Read the adapter source and verify it uses --acp, not --experimental-acp.
// This is a static-analysis guard: if someone reverts the flag, the test
// catches it before any runtime failure.

process.stdout.write("\nTest 2: source-code flag inspection\n");

const fs = await import("node:fs");
const source = fs.readFileSync(adapterPath, "utf8");

// The args array in runAcpPromptQwen must contain "--acp".
assert(source.includes('"--acp"'), 'adapter source contains "--acp"');

// The adapter must NOT pass "--experimental-acp" in any args array.
assert(
  !source.includes('"--experimental-acp"'),
  'adapter source does NOT contain "--experimental-acp" in args'
);

// The comment documenting the migration should mention v0.15.6
assert(
  source.includes("v0.15.6"),
  "adapter comment references Qwen Code v0.15.6"
);

// ─── Test 3: binary resolution (non-fatal if Qwen is not installed) ───────────

process.stdout.write("\nTest 3: binary resolution\n");
const avail = getQwenAvailability();
if (avail.available) {
  process.stdout.write(`  INFO: Qwen Code CLI found — ${avail.detail}\n`);
  assert(avail.version !== null, `version string is non-null (got: ${avail.version})`);
} else {
  process.stdout.write(`  SKIP: Qwen Code CLI not installed — ${avail.detail}\n`);
  process.stdout.write("  (binary resolution logic was still exercised; no crash = pass)\n");
}

// ─── Test 4: verify --acp is accepted by the installed Qwen binary ─────────────
//
// If Qwen is installed, run `qwen --help` and confirm --acp is listed
// and --experimental-acp is either absent or marked deprecated.

if (avail.available) {
  process.stdout.write("\nTest 4: Qwen --help flag verification\n");
  try {
    const helpOutput = execSync(`"${avail.detail.split(" ")[0]}" --help`, {
      encoding: "utf8",
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 8000
    });

    assert(helpOutput.includes("--acp"), "qwen --help lists --acp");

    // --experimental-acp may still appear (deprecated alias) — that's OK.
    // We just verify --acp is the primary/stable flag.
    if (helpOutput.includes("--experimental-acp")) {
      process.stdout.write("  INFO: --experimental-acp still present (deprecated alias) — OK\n");
    }
  } catch (err) {
    process.stdout.write(`  SKIP: qwen --help failed — ${err.message ?? err}\n`);
  }
} else {
  process.stdout.write("\nTest 4: SKIP (Qwen not installed)\n");
}

// ─── Summary ───────────────────────────────────────────────────────────────────

process.stdout.write("\n");
if (failures > 0) {
  process.stderr.write(`${failures} test(s) FAILED\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("All tests passed.\n");
}

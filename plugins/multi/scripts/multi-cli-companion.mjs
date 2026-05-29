#!/usr/bin/env node

import process from "node:process";

import { getAdapter } from "./lib/adapters/registry.mjs";
import { handleSetup } from "./lib/commands/setup.mjs";
import {
  handleCancel,
  handleResult,
  handleStatus,
  handleTaskResumeCandidate
} from "./lib/commands/jobs.mjs";
import {
  handleReview,
  handleReviewCommand
} from "./lib/commands/review.mjs";
import {
  handleTask,
  handleTaskWorker
} from "./lib/commands/task.mjs";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  Global flags:",
      "    --cli <codex|cursor|antigravity>   Select the CLI adapter (default: codex)",
      "  node scripts/multi-cli-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/multi-cli-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/multi-cli-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/multi-cli-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--until-done [--max-turns N]] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/multi-cli-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/multi-cli-companion.mjs result [job-id] [--json]",
      "  node scripts/multi-cli-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

async function main() {
  const rawArgv = process.argv.slice(2);
  // Parse --cli <name> from the raw argv before splitting subcommand.
  // Default to 'codex' for backwards compatibility.
  const cliArgIndex = rawArgv.indexOf('--cli');
  const cliName = cliArgIndex !== -1 && rawArgv[cliArgIndex + 1]
    ? rawArgv[cliArgIndex + 1]
    : 'codex';
  // Validate early so users get a clear error.
  const _adapter = getAdapter(cliName); // eslint-disable-line no-unused-vars

  // Remove --cli <name> from argv before extracting subcommand. Guard
  // cliArgIndex so we don't drop argv[0] when --cli is absent (cliArgIndex=-1
  // would make cliArgIndex+1 === 0 and silently consume the subcommand).
  const filteredArgv = cliArgIndex >= 0
    ? rawArgv.filter((_, i) => i !== cliArgIndex && i !== cliArgIndex + 1)
    : rawArgv;
  const [subcommand, ...argv] = filteredArgv;
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv, { cli: cliName });
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

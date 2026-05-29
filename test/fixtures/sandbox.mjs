// Reusable throwaway git-repo fixture for LIVE adapter tests.
//
// Offline (git only). Auto-cleanup is best-effort: a Codex run may leave a
// detached broker holding the directory open on Windows (see ARCHITECTURE.md →
// "Broker lifecycle"), so cleanup swallows EBUSY rather than failing the test.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Create an isolated git repo seeded with files.
 *
 * @param {{ files?: Record<string,string>, commitFirst?: boolean }} [opts]
 *   files       — relative path → contents, written before the optional commit
 *   commitFirst — commit the seeded files so later edits show as a diff (default true)
 * @returns {{ dir: string, write(rel: string, content: string): void, cleanup(): void }}
 */
export function createSandbox({ files = {}, commitFirst = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcli-sbx-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });

  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");

  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), content);
  }
  if (commitFirst) {
    git("add", "-A");
    git("commit", "-qm", "fixture");
  }

  return {
    dir,
    write(rel, content) {
      fs.writeFileSync(path.join(dir, rel), content);
    },
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // A lingering broker may hold the cwd handle; leave it for OS cleanup.
      }
    },
  };
}

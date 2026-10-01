import { realpath } from 'node:fs/promises';
import type { MessagesRequest } from '../../multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../multi-core/src/gateway/mode-hook.ts';
import type { CursorHarness } from './harness.ts';

/** A Claude worktree must use its own SDK workspace and effective settings. */
export class CursorWorkspaces {
  private readonly harnesses = new Map<string, CursorHarness>();
  private closed = false;
  private readonly create: (cwd: string) => CursorHarness;
  private readonly cwd: string;

  constructor(create: (cwd: string) => CursorHarness, cwd = process.cwd()) {
    this.create = create;
    this.cwd = cwd;
  }

  // Validation does not execute or open SDK state; runtime routing canonicalizes cwd.
  validate(body: MessagesRequest, context?: PermissionContext) {
    return this.harness(this.cwd).validate(body, context);
  }

  async handle(...args: Parameters<CursorHarness['handle']>) {
    const cwd = await realpath(args[4]?.cwd ?? this.cwd);
    return this.harness(cwd).handle(...args);
  }

  /** The scope's last reply, read from the workspace that `handle` would route it to. */
  async recordedResponse(scope: string, context?: PermissionContext) {
    const cwd = await realpath(context?.cwd ?? this.cwd);
    return this.harness(cwd).recordedResponse(scope);
  }

  async billedUsageForSession(sessionId: string) {
    const batches = await Promise.all(
      [...this.harnesses.values()].map((harness) => harness.billedUsageForSession(sessionId)),
    );
    return batches.flat();
  }

  private harness(cwd: string) {
    if (this.closed) {
      throw new Error('Cursor workspaces are closed');
    }
    let harness = this.harnesses.get(cwd);
    if (!harness) {
      harness = this.create(cwd);
      this.harnesses.set(cwd, harness);
    }
    return harness;
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.harnesses.values()].map((harness) => harness.close()));
    this.harnesses.clear();
  }
}

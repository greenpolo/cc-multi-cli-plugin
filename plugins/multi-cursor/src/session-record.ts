import { createHash } from 'node:crypto';
import path from 'node:path';
import { isRecord } from '../../multi-core/src/gateway/harness-session.ts';

/** The v2 gateway hashed the serialized [workspace, scope] directly. */
export function legacyCursorSessionFile(directory: string, identity: string): string {
  const key = createHash('sha256').update(identity).digest('hex');
  return path.join(directory, `${key}.session.json`);
}

/**
 * Selects the native identity for migration or read-only billing. The store holds
 * both generations' locks before persisting this result or dispatching a turn.
 */
export async function restoreCursorSession({
  identity,
  files,
  read,
}: {
  identity: string;
  files: readonly string[];
  read: (file: string) => Promise<unknown>;
}): Promise<{ saved: unknown; migrated?: boolean }> {
  const current = await read(files[0]);
  const legacy = await read(files[1]);
  if (current !== undefined) {
    if (
      isRecord(current) &&
      current.version === 3 &&
      isRecord(legacy) &&
      legacy.version === 2 &&
      current.agentId !== legacy.agentId
    ) {
      throw new Error(
        `Cursor session has ambiguous legacy and current native ownership; refusing replay. Stop both gateways and follow docs/cursor.md#legacy-record-recovery. Current record: ${files[0]}; legacy record: ${files[1]}`,
      );
    }
    return { saved: current };
  }
  if (legacy === undefined) {
    return { saved: undefined };
  }
  if (!isRecord(legacy) || legacy.version !== 2) {
    throw new Error('Cursor legacy session has unsupported state; refusing native replay');
  }
  const { pending, ...saved } = legacy;
  return {
    saved: {
      ...saved,
      version: 3,
      provider: 'Cursor',
      identity,
      interrupted: saved.interrupted === undefined ? pending : saved.interrupted,
    },
    migrated: true,
  };
}

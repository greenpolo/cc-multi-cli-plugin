import assert from 'node:assert/strict';
import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  archiveHarnessReply,
  pruneArchives,
} from '../../plugins/multi-core/src/gateway/harness-completion.ts';
import type {
  HarnessSession,
  HarnessSessionBase,
} from '../../plugins/multi-core/src/gateway/harness-session.ts';
import { removeTemporary } from '../temporary.ts';

async function seedArchives(directory: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const file = path.join(directory, `old${index}.response.json`);
    await writeFile(file, '{}');
    const seconds = 1_000_000 + index;
    await utimes(file, seconds, seconds);
  }
  await writeFile(path.join(directory, 'keep.session.json'), '{}');
}

test('pruneArchives keeps the newest archives and never touches other files', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'archive-prune-'));
  t.after(() => removeTemporary(directory));
  await seedArchives(directory, 10);
  await pruneArchives(directory, {
    keep: 4,
    maxAgeMs: Number.MAX_SAFE_INTEGER,
    now: 2_000_000_000,
  });
  const left = (await readdir(directory)).sort();
  assert.deepEqual(left, [
    'keep.session.json',
    'old6.response.json',
    'old7.response.json',
    'old8.response.json',
    'old9.response.json',
  ]);
});

test('pruneArchives drops archives older than the age limit', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'archive-age-'));
  t.after(() => removeTemporary(directory));
  await seedArchives(directory, 3);
  // mtimes are in seconds; `now` is in milliseconds.
  await pruneArchives(directory, { keep: 10, maxAgeMs: 1000, now: 1_000_100_000 });
  assert.deepEqual(await readdir(directory), ['keep.session.json']);
});

test('archiveHarnessReply writes the archive and then prunes the directory', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'archive-turn-'));
  t.after(() => removeTemporary(directory));
  await seedArchives(directory, 5);
  const key = 'f'.repeat(64);
  const session = {
    saved: { replay: { key, events: [] }, response: { id: 'x' } },
  } as unknown as HarnessSession<HarnessSessionBase, object>;
  await archiveHarnessReply({
    session,
    stateDirectory: directory,
    platform: 'linux',
    keep: 2,
    maxAgeMs: Number.MAX_SAFE_INTEGER,
  });
  const left = (await readdir(directory)).filter((name) => name.endsWith('.response.json'));
  assert.equal(left.length, 2);
  assert.ok(left.includes(`${key}.response.json`));
});
